import { Router } from "express";
import dayjs from "dayjs";
import { db, asRow } from "../db";
import { requireAuth, requireRole, requireEmployee } from "../middleware/auth";
import { t } from "../i18n";
import {
  planFromFixedAmount,
  planFromMonths,
  resolveEffectiveLoanLimits,
  validateLoanPlan,
  type LoanPlan,
} from "../services/loanCalculationService";
import { submitRequest, getApprovalTrail, employeeIdToUserId } from "../services/workflowEngine";
import { notify } from "../services/notificationService";
import type { Employee, LoanRule, LoanRuleOverride, LoanRequest } from "../models/types";

export const loansRouter = Router();

function currentEmployee(req: any): Employee {
  return asRow<Employee>(
    db.prepare("SELECT * FROM employees WHERE id = ?").get(req.session.user.employeeId)
  );
}

function getEffectiveLimits(employeeId: number) {
  const companyDefault = asRow<LoanRule>(
    db.prepare("SELECT * FROM loan_rules WHERE scope = 'company' LIMIT 1").get()
  );
  const override = asRow<LoanRuleOverride | undefined>(
    db.prepare("SELECT * FROM loan_rule_overrides WHERE employee_id = ?").get(employeeId)
  );
  return resolveEffectiveLoanLimits(companyDefault, override ?? null);
}

function activeLoanCount(employeeId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM loan_requests
       WHERE employee_id = ? AND status IN ('pending','approved','disbursed')`
    )
    .get(employeeId) as { n: number };
  return row.n;
}

loansRouter.get("/loans", requireAuth, requireEmployee, (req, res) => {
  const lang = req.session.user!.language;
  const employee = currentEmployee(req);

  const requests = asRow<LoanRequest[]>(
    db.prepare("SELECT * FROM loan_requests WHERE employee_id = ? ORDER BY created_at DESC").all(employee.id)
  );

  res.render("loans/index", { title: t(lang, "nav.myLoans"), lang, requests });
});

loansRouter.get("/loans/new", requireAuth, requireEmployee, (req, res) => {
  const lang = req.session.user!.language;
  const employee = currentEmployee(req);
  const limits = getEffectiveLimits(employee.id);

  res.render("loans/new", {
    title: t(lang, "nav.myLoans"),
    lang,
    employee,
    limits,
    error: null,
    form: { repaymentOption: "fixed_amount" },
    plan: null,
  });
});

function buildPlanFromBody(body: Record<string, string>): LoanPlan {
  const amount = Number(body.amount);
  const firstMonth = body.firstDeductionMonth;
  if (body.repaymentOption === "months") {
    return planFromMonths(amount, Number(body.months), firstMonth);
  }
  return planFromFixedAmount(amount, Number(body.monthlyAmount), firstMonth);
}

loansRouter.post("/loans/preview", requireAuth, requireEmployee, (req, res) => {
  const employee = currentEmployee(req);
  const body = req.body as Record<string, string>;
  try {
    const amount = Number(body.amount);
    const plan = buildPlanFromBody(body);
    const limits = getEffectiveLimits(employee.id);
    const validation = validateLoanPlan(amount, plan, limits, employee.gross_salary, activeLoanCount(employee.id));
    res.json({ plan, validation });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

loansRouter.post("/loans/new", requireAuth, requireEmployee, (req, res) => {
  const lang = req.session.user!.language;
  const employee = currentEmployee(req);
  const sessionUser = req.session.user!;
  const body = req.body as Record<string, string>;
  const limits = getEffectiveLimits(employee.id);

  const renderError = (message: string, plan: LoanPlan | null = null) =>
    res.status(400).render("loans/new", {
      title: t(lang, "nav.myLoans"),
      lang,
      employee,
      limits,
      error: message,
      form: body,
      plan,
    });

  const amount = Number(body.amount);
  if (!amount || amount <= 0) {
    renderError(lang === "ar" ? "مبلغ غير صالح." : "Invalid amount.");
    return;
  }
  if (!body.termsAccepted) {
    renderError(
      lang === "ar"
        ? "يجب الموافقة على شروط السلفة."
        : "You must accept the loan terms."
    );
    return;
  }

  let plan: LoanPlan;
  try {
    plan = buildPlanFromBody(body);
  } catch (err) {
    renderError((err as Error).message);
    return;
  }

  const validation = validateLoanPlan(
    amount,
    plan,
    limits,
    employee.gross_salary,
    activeLoanCount(employee.id)
  );
  if (!validation.valid) {
    renderError(validation.errors.join(" "), plan);
    return;
  }

  const insert = db.prepare(
    `INSERT INTO loan_requests
      (employee_id, amount, reason, repayment_option, monthly_amount, months, first_deduction_month, terms_accepted, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'draft')`
  );
  const result = insert.run(
    employee.id,
    amount,
    body.reason || null,
    body.repaymentOption,
    plan.monthlyAmount,
    plan.months,
    body.firstDeductionMonth
  );
  const requestId = Number(result.lastInsertRowid);

  const insertInstalment = db.prepare(
    `INSERT INTO loan_instalments (loan_request_id, instalment_number, due_month, amount, status)
     VALUES (?, ?, ?, ?, 'scheduled')`
  );
  for (const entry of plan.schedule) {
    insertInstalment.run(requestId, entry.instalmentNumber, entry.dueMonth, entry.amount);
  }

  try {
    submitRequest("loan", requestId, employee, { amount });
  } catch (err) {
    renderError((err as Error).message, plan);
    return;
  }

  db.prepare(
    `INSERT INTO audit_log (user_id, action, record_type, record_id, new_value_json, ip_address)
     VALUES (?, 'submit_loan_request', 'loan_requests', ?, ?, ?)`
  ).run(sessionUser.userId, requestId, JSON.stringify(body), req.ip ?? null);

  res.redirect("/loans");
});

loansRouter.get("/loans/:id", requireAuth, requireEmployee, (req, res) => {
  const lang = req.session.user!.language;
  const employee = currentEmployee(req);
  const id = Number(req.params.id);

  const request = asRow<LoanRequest | undefined>(
    db.prepare("SELECT * FROM loan_requests WHERE id = ? AND employee_id = ?").get(id, employee.id)
  );
  if (!request) {
    res.status(404).render("errors/404", { title: "Not found" });
    return;
  }

  const instalments = db
    .prepare("SELECT * FROM loan_instalments WHERE loan_request_id = ? ORDER BY instalment_number")
    .all(id);
  const trail = getApprovalTrail("loan", id);

  res.render("loans/detail", { title: t(lang, "nav.myLoans"), lang, request, instalments, trail });
});

loansRouter.post("/loans/:id/cancel", requireAuth, requireEmployee, (req, res) => {
  const employee = currentEmployee(req);
  const id = Number(req.params.id);
  const request = asRow<LoanRequest | undefined>(
    db.prepare("SELECT * FROM loan_requests WHERE id = ? AND employee_id = ?").get(id, employee.id)
  );
  if (request && (request.status === "pending" || request.status === "returned")) {
    db.prepare("UPDATE loan_requests SET status = 'cancelled' WHERE id = ?").run(id);
  }
  res.redirect("/loans");
});

// --- Finance actions -------------------------------------------------

loansRouter.get("/loans-finance", requireAuth, requireRole("finance", "system_admin"), (req, res) => {
  const lang = req.session.user!.language;
  const loans = db
    .prepare(
      `SELECT lo.*, e.name_en, e.name_ar, e.employee_code
       FROM loan_requests lo JOIN employees e ON e.id = lo.employee_id
       WHERE lo.status IN ('approved','disbursed')
       ORDER BY lo.created_at DESC`
    )
    .all();
  res.render("loans/finance", { title: lang === "ar" ? "السلف - المالية" : "Loans - Finance", lang, loans });
});

loansRouter.get(
  "/loans/:id/instalments",
  requireAuth,
  requireRole("finance", "system_admin"),
  (req, res) => {
    const lang = req.session.user!.language;
    const id = Number(req.params.id);
    const loan = db
      .prepare(
        `SELECT lo.*, e.name_en, e.name_ar, e.employee_code
         FROM loan_requests lo JOIN employees e ON e.id = lo.employee_id WHERE lo.id = ?`
      )
      .get(id);
    if (!loan) {
      res.status(404).render("errors/404", { title: "Not found" });
      return;
    }
    const instalments = db
      .prepare("SELECT * FROM loan_instalments WHERE loan_request_id = ? ORDER BY instalment_number")
      .all(id);
    res.render("loans/instalments", {
      title: lang === "ar" ? "الأقساط" : "Instalments",
      lang,
      loan,
      instalments,
    });
  }
);

// LN-13: Finance can record early settlement with a reason (logged).
loansRouter.post(
  "/loans/:id/settle",
  requireAuth,
  requireRole("finance", "system_admin"),
  (req, res) => {
    const id = Number(req.params.id);
    const reason = (req.body.reason as string) || "";
    if (!reason.trim()) {
      res.status(400).send("A reason is required to record an early settlement.");
      return;
    }

    db.prepare(
      "UPDATE loan_instalments SET status = 'skipped' WHERE loan_request_id = ? AND status != 'deducted'"
    ).run(id);
    db.prepare("UPDATE loan_requests SET status = 'closed', closed_at = ? WHERE id = ?").run(
      dayjs().toISOString(),
      id
    );

    db.prepare(
      `INSERT INTO audit_log (user_id, action, record_type, record_id, new_value_json, ip_address)
       VALUES (?, 'early_settle_loan', 'loan_requests', ?, ?, ?)`
    ).run(req.session.user!.userId, id, JSON.stringify({ reason }), req.ip ?? null);

    const loan = db.prepare("SELECT employee_id FROM loan_requests WHERE id = ?").get(id) as {
      employee_id: number;
    };
    const notifyUserId = employeeIdToUserId(loan.employee_id);
    if (notifyUserId != null) {
      notify(
        notifyUserId,
        "loan_settled",
        `Your loan was settled early. Reason: ${reason}`,
        `تمت تسوية سلفتك مبكراً. السبب: ${reason}`,
        `/loans/${id}`
      );
    }

    res.redirect(`/loans/${id}/instalments`);
  }
);

loansRouter.post(
  "/loans/:id/disburse",
  requireAuth,
  requireRole("finance", "system_admin"),
  (req, res) => {
    const id = Number(req.params.id);
    db.prepare(
      "UPDATE loan_requests SET status = 'disbursed', disbursed_at = ? WHERE id = ? AND status = 'approved'"
    ).run(dayjs().toISOString(), id);
    db.prepare(
      `INSERT INTO audit_log (user_id, action, record_type, record_id, ip_address)
       VALUES (?, 'disburse_loan', 'loan_requests', ?, ?)`
    ).run(req.session.user!.userId, id, req.ip ?? null);
    res.redirect("/loans-finance");
  }
);

loansRouter.post(
  "/loans/:id/instalments/:n/deduct",
  requireAuth,
  requireRole("finance", "system_admin"),
  (req, res) => {
    const loanId = Number(req.params.id);
    const n = Number(req.params.n);
    db.prepare(
      "UPDATE loan_instalments SET status = 'deducted', deducted_at = ? WHERE loan_request_id = ? AND instalment_number = ?"
    ).run(dayjs().toISOString(), loanId, n);

    const loanForNotify = db
      .prepare("SELECT employee_id, monthly_amount FROM loan_requests WHERE id = ?")
      .get(loanId) as { employee_id: number; monthly_amount: number };
    const notifyUserId = employeeIdToUserId(loanForNotify.employee_id);
    if (notifyUserId != null) {
      notify(
        notifyUserId,
        "loan_instalment_deducted",
        `Loan instalment #${n} (SAR ${loanForNotify.monthly_amount}) was deducted.`,
        `تم خصم القسط رقم ${n} (${loanForNotify.monthly_amount} ريال) من سلفتك.`,
        `/loans/${loanId}`
      );
    }

    const remaining = db
      .prepare(
        "SELECT COUNT(*) as n FROM loan_instalments WHERE loan_request_id = ? AND status != 'deducted'"
      )
      .get(loanId) as { n: number };
    if (remaining.n === 0) {
      db.prepare("UPDATE loan_requests SET status = 'closed', closed_at = ? WHERE id = ?").run(
        dayjs().toISOString(),
        loanId
      );
    }

    db.prepare(
      `INSERT INTO audit_log (user_id, action, record_type, record_id, ip_address)
       VALUES (?, 'deduct_instalment', 'loan_instalments', ?, ?)`
    ).run(req.session.user!.userId, loanId, req.ip ?? null);

    res.redirect("/loans-finance");
  }
);
