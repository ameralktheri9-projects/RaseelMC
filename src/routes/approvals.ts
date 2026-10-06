import { Router } from "express";
import { db, asRow } from "../db";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { t } from "../i18n";
import { advanceRequest, getApprovalTrail, buildApprovalRoute } from "../services/workflowEngine";
import {
  computeLeaveBalance,
  getEntitlementRules,
  getOrCreateLeaveBalanceRow,
  getPendingLeaveDays,
} from "../services/leaveCalculationService";
import type { Employee, RequestType } from "../models/types";

export const approvalsRouter = Router();

/** Resolves who can actually act on a request's current step right now, or null if it's not pending/resolvable. */
async function resolveCurrentApproverUserId(requestType: RequestType, id: number): Promise<number | null> {
  const table = requestType === "leave" ? "leave_requests" : "loan_requests";
  const request = (await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)) as any;
  if (!request || request.status !== "pending" || request.workflow_id == null) return null;

  const workflow = asRow<any>(await db.prepare("SELECT * FROM workflows WHERE id = ?").get(request.workflow_id));
  if (!workflow) return null;
  const employee = asRow<Employee>(await db.prepare("SELECT * FROM employees WHERE id = ?").get(request.employee_id));
  const route = await buildApprovalRoute(workflow, employee);
  const step = route.find((s) => s.stepOrder === request.current_step_order);
  if (!step || step.skipped) return null;
  return step.approverUserId;
}

approvalsRouter.get(
  "/approvals/delegate",
  requireAuth,
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const userId = req.session.user!.userId;

    const users = await db
      .prepare(
        `SELECT u.id, u.username, e.name_en, e.name_ar FROM users u
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE u.id != ? AND u.is_active = 1 ORDER BY e.name_en`
      )
      .all(userId);
    const active = await db
      .prepare(
        `SELECT d.*, u.username, e.name_en, e.name_ar FROM delegations d
         JOIN users u ON u.id = d.delegate_user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE d.approver_user_id = ? ORDER BY d.start_date DESC`
      )
      .all(userId);

    res.render("approvals/delegate", {
      title: lang === "ar" ? "تفويض الموافقات" : "Delegate approvals",
      lang,
      users,
      active,
    });
  })
);

approvalsRouter.post(
  "/approvals/delegate",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.session.user!.userId;
    const { delegateUserId, startDate, endDate } = req.body as Record<string, string>;
    await db.prepare(
      "INSERT INTO delegations (approver_user_id, delegate_user_id, start_date, end_date) VALUES (?, ?, ?, ?)"
    ).run(userId, Number(delegateUserId), startDate, endDate);
    res.redirect("/approvals/delegate");
  })
);

approvalsRouter.post(
  "/approvals/delegate/:id/delete",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.session.user!.userId;
    await db.prepare("DELETE FROM delegations WHERE id = ? AND approver_user_id = ?").run(
      Number(req.params.id),
      userId
    );
    res.redirect("/approvals/delegate");
  })
);

approvalsRouter.get(
  "/approvals",
  requireAuth,
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const userId = req.session.user!.userId;
    const isAdmin = req.session.user!.roles.includes("system_admin");

    const pending = (await db
      .prepare(
        `SELECT lr.id, 'leave' as request_type, lr.current_step_order, lr.created_at, lr.working_days as amount,
                e.name_en, e.name_ar, e.employee_code, d.name_en as dept_en, d.name_ar as dept_ar,
                lt.name_en as sub_type_en, lt.name_ar as sub_type_ar,
                lr.start_date, lr.end_date, lr.workflow_id
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         JOIN leave_types lt ON lt.id = lr.leave_type_id
         WHERE lr.status = 'pending'
         UNION ALL
         SELECT lo.id, 'loan' as request_type, lo.current_step_order, lo.created_at, lo.amount,
                e.name_en, e.name_ar, e.employee_code, d.name_en as dept_en, d.name_ar as dept_ar,
                'Loan' as sub_type_en, 'سلفة' as sub_type_ar,
                NULL as start_date, NULL as end_date, lo.workflow_id
         FROM loan_requests lo
         JOIN employees e ON e.id = lo.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         WHERE lo.status = 'pending'
         ORDER BY 4 DESC`
      )
      .all()) as any[];

    // System Admin gets full company-wide oversight of every pending request (and can act on any of
    // them as an override); everyone else only sees requests actually waiting on their own step.
    const myPending: any[] = [];
    for (const r of pending) {
      const approverUserId = await resolveCurrentApproverUserId(r.request_type, r.id);
      if (isAdmin) {
        myPending.push({ ...r, isMine: approverUserId === userId });
      } else if (approverUserId === userId) {
        myPending.push({ ...r, isMine: true });
      }
    }

    const decided = await db
      .prepare(
        `SELECT aa.*,
                CASE WHEN aa.request_type = 'leave' THEN lr.employee_id ELSE lo.employee_id END as employee_id
         FROM approval_actions aa
         LEFT JOIN leave_requests lr ON aa.request_type = 'leave' AND lr.id = aa.request_id
         LEFT JOIN loan_requests lo ON aa.request_type = 'loan' AND lo.id = aa.request_id
         WHERE aa.approver_user_id = ? AND aa.action IN ('approved','rejected','returned')
         ORDER BY aa.created_at DESC LIMIT 50`
      )
      .all(userId);

    res.render("approvals/index", {
      title: t(lang, "nav.approvals"),
      lang,
      pending: myPending,
      decided,
    });
  })
);

approvalsRouter.get(
  "/approvals/:type/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const sessionUser = req.session.user!;
    const requestType = req.params.type as RequestType;
    const id = Number(req.params.id);
    const resolvedApproverUserId = await resolveCurrentApproverUserId(requestType, id);
    const isAdmin = sessionUser.roles.includes("system_admin");
    const isAdminOverride = isAdmin && resolvedApproverUserId !== sessionUser.userId;
    const canActHere = resolvedApproverUserId === sessionUser.userId || isAdmin;

    if (requestType === "leave") {
      const request = (await db
        .prepare(
          `SELECT lr.*, lt.name_en as type_name_en, lt.name_ar as type_name_ar,
                  e.name_en as emp_name_en, e.name_ar as emp_name_ar, e.employee_code, e.job_title,
                  h.name_en as handover_name_en, h.name_ar as handover_name_ar
           FROM leave_requests lr
           JOIN leave_types lt ON lt.id = lr.leave_type_id
           JOIN employees e ON e.id = lr.employee_id
           LEFT JOIN employees h ON h.id = lr.handover_employee_id
           WHERE lr.id = ?`
        )
        .get(id)) as any;

      if (!request) {
        res.status(404).render("errors/404", { title: "Not found" });
        return;
      }

      const employee = asRow<Employee>(
        await db.prepare("SELECT * FROM employees WHERE id = ?").get(request.employee_id)
      );
      const rules = await getEntitlementRules();
      const asOf = new Date().toISOString().slice(0, 10);
      const pending = await getPendingLeaveDays(employee.id, request.leave_type_id);
      const prelim = computeLeaveBalance({
        employee,
        asOf,
        entitlementRules: rules,
        carriedOver: 0,
        taken: 0,
        pending,
        manualAdjustment: 0,
      });
      const balanceRow = await getOrCreateLeaveBalanceRow(
        employee.id,
        request.leave_type_id,
        prelim.leaveYearStart,
        prelim.leaveYearEnd,
        prelim.fullYearEntitlement
      );
      const balance = computeLeaveBalance({
        employee,
        asOf,
        entitlementRules: rules,
        carriedOver: balanceRow.carried_over,
        taken: balanceRow.taken,
        pending,
        manualAdjustment: balanceRow.manual_adjustment,
      });

      const trail = await getApprovalTrail("leave", id);
      const canAct = request.status === "pending" && canActHere;

      res.render("approvals/detail-leave", {
        title: t(lang, "nav.approvals"),
        lang,
        request,
        balance,
        trail,
        canAct,
        isAdminOverride,
        error: req.query.error === "comment_required" ? "comment_required" : null,
      });
      return;
    }

    // loan
    const request = await db
      .prepare(
        `SELECT lo.*, e.name_en as emp_name_en, e.name_ar as emp_name_ar, e.employee_code, e.job_title
         FROM loan_requests lo JOIN employees e ON e.id = lo.employee_id
         WHERE lo.id = ?`
      )
      .get(id);

    if (!request) {
      res.status(404).render("errors/404", { title: "Not found" });
      return;
    }

    const trail = await getApprovalTrail("loan", id);
    const canAct = (request as any).status === "pending" && canActHere;
    res.render("approvals/detail-loan", {
      title: t(lang, "nav.approvals"),
      lang,
      request,
      trail,
      canAct,
      isAdminOverride,
      error: req.query.error === "comment_required" ? "comment_required" : null,
    });
  })
);

approvalsRouter.post(
  "/approvals/:type/:id/action",
  requireAuth,
  asyncHandler(async (req, res) => {
    const requestType = req.params.type as RequestType;
    const id = Number(req.params.id);
    const sessionUser = req.session.user!;
    const { action, comment } = req.body as { action: "approve" | "reject" | "return"; comment?: string };

    if ((action === "reject" || action === "return") && !comment) {
      res.redirect(`/approvals/${requestType}/${id}?error=comment_required`);
      return;
    }

    const table = requestType === "leave" ? "leave_requests" : "loan_requests";
    const request = (await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)) as any;
    if (!request) {
      res.status(404).send("Not found");
      return;
    }

    // Authorization: only the step's actually-resolved approver (or System Admin, as an override)
    // may act here — this used to be unchecked, so any logged-in user could approve/reject any
    // request by guessing its URL.
    const resolvedApproverUserId = await resolveCurrentApproverUserId(requestType, id);
    const isAdmin = sessionUser.roles.includes("system_admin");
    if (resolvedApproverUserId !== sessionUser.userId && !isAdmin) {
      res.status(403).render("errors/403", { title: "Forbidden" });
      return;
    }

    const employee = asRow<Employee>(
      await db.prepare("SELECT * FROM employees WHERE id = ?").get(request.employee_id)
    );

    const actionMap = { approve: "approved", reject: "rejected", return: "returned" } as const;

    const result = await advanceRequest(
      requestType,
      id,
      employee,
      sessionUser.userId,
      actionMap[action],
      comment || null
    );

    // LV-16: approved leave days are deducted from the balance automatically.
    if (requestType === "leave" && result.newStatus === "approved") {
      const rules = await getEntitlementRules();
      const asOf = new Date().toISOString().slice(0, 10);
      const { leaveYearStart, leaveYearEnd } = computeLeaveBalance({
        employee,
        asOf,
        entitlementRules: rules,
        carriedOver: 0,
        taken: 0,
        pending: 0,
        manualAdjustment: 0,
      });
      const balanceRow = await getOrCreateLeaveBalanceRow(
        employee.id,
        request.leave_type_id,
        leaveYearStart,
        leaveYearEnd,
        0
      );
      if (request.is_cancellation_of) {
        // Approving a cancellation request restores the days on the original leave and cancels it.
        await db.prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id = ?").run(
          request.is_cancellation_of
        );
        await db.prepare("UPDATE leave_balances SET taken = taken - ? WHERE id = ?").run(
          request.working_days,
          balanceRow.id
        );
      } else {
        await db.prepare("UPDATE leave_balances SET taken = taken + ? WHERE id = ?").run(
          request.working_days,
          balanceRow.id
        );
      }
    }

    await db.prepare(
      `INSERT INTO audit_log (user_id, action, record_type, record_id, new_value_json, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      sessionUser.userId,
      `${action}_${requestType}_request`,
      table,
      id,
      JSON.stringify({ action, comment }),
      req.ip ?? null
    );

    res.redirect("/approvals");
  })
);
