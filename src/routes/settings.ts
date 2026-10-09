import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { db, asRow } from "../db";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { hashPassword, generateTemporaryPassword } from "../utils/password";
import { NATIONALITIES, CR_TYPES, SPONSORSHIP_TYPES, SAUDI_BANKS } from "../constants/hrLookups";
import {
  computeLeaveBalance,
  getEntitlementRules,
  getOrCreateLeaveBalanceRow,
  getPendingLeaveDays,
  leaveYearWindow,
  resolveAnnualEntitlement,
  yearsOfService,
} from "../services/leaveCalculationService";
import { planFromMonths } from "../services/loanCalculationService";
import dayjs from "dayjs";
import type {
  Workflow,
  WorkflowStep,
  CarryOverSetting,
  LoanRule,
  LeaveType,
  Holiday,
  Employee,
  Department,
  ApproverType,
  OrgRole,
} from "../models/types";

const NOW_SQL = "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

export const settingsRouter = Router();

// Scoped to this router's actual path prefixes only — an unscoped .use() here would otherwise
// gate every request that falls through to it (e.g. /notifications/recent for a non-admin user),
// since Express runs a path-less router.use() for any request reaching the router at all.
settingsRouter.use(["/settings", "/audit-log"], requireAuth, requireRole("hr_officer", "system_admin"));

async function audit(req: any, action: string, recordType: string, recordId: number | null, oldVal: any, newVal: any) {
  await db.prepare(
    `INSERT INTO audit_log (user_id, action, record_type, record_id, old_value_json, new_value_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.session.user.userId,
    action,
    recordType,
    recordId,
    oldVal != null ? JSON.stringify(oldVal) : null,
    newVal != null ? JSON.stringify(newVal) : null,
    req.ip ?? null
  );
}

settingsRouter.get("/settings", (_req, res) => res.redirect("/settings/workflows"));

// --- Approval workflows (SC-08) ---------------------------------------

settingsRouter.get(
  "/settings/workflows",
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const workflows = asRow<Workflow[]>(
      await db.prepare("SELECT * FROM workflows ORDER BY request_type, is_default DESC, id").all()
    );
    const selectedId = req.query.id ? Number(req.query.id) : workflows[0]?.id;
    const selected = workflows.find((w) => w.id === selectedId) ?? null;
    const steps = selected
      ? asRow<WorkflowStep[]>(
          await db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(selected.id)
        )
      : [];
    const employees = asRow<Employee[]>(await db.prepare("SELECT * FROM employees ORDER BY name_en").all());
    const users = await db.prepare("SELECT id, username, employee_id FROM users WHERE is_active = 1").all();

    res.render("settings/workflows", {
      title: lang === "ar" ? "الإعدادات" : "Settings",
      lang,
      workflows,
      selected,
      steps,
      employees,
      users,
    });
  })
);

settingsRouter.post(
  "/settings/workflows",
  asyncHandler(async (req, res) => {
    const { nameEn, nameAr, requestType } = req.body as Record<string, string>;
    const inserted = (await db
      .prepare(
        `INSERT INTO workflows (name_en, name_ar, request_type, is_active, is_default, conditions_json)
         VALUES (?, ?, ?, 1, 0, '{}') RETURNING id`
      )
      .get(nameEn, nameAr, requestType)) as { id: number };
    await audit(req, "create_workflow", "workflows", inserted.id, null, req.body);
    res.redirect(`/settings/workflows?id=${inserted.id}`);
  })
);

settingsRouter.post(
  "/settings/workflows/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body as Record<string, string>;
    const old = await db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);

    const conditions: Record<string, number> = {};
    if (body.condMinDays) conditions.minDays = Number(body.condMinDays);
    if (body.condMaxDays) conditions.maxDays = Number(body.condMaxDays);
    if (body.condMinAmount) conditions.minAmount = Number(body.condMinAmount);
    if (body.condMaxAmount) conditions.maxAmount = Number(body.condMaxAmount);
    if (body.condDepartmentId) conditions.departmentId = Number(body.condDepartmentId);
    if (body.condLeaveTypeId) conditions.leaveTypeId = Number(body.condLeaveTypeId);

    // Editing bumps the version so in-flight requests keep the version they started with (WF-10).
    await db.prepare(
      `UPDATE workflows SET name_en = ?, name_ar = ?, is_active = ?, conditions_json = ?,
         skip_duplicate_approver = ?, version = version + 1, updated_at = ${NOW_SQL}
       WHERE id = ?`
    ).run(
      body.nameEn,
      body.nameAr,
      body.isActive ? 1 : 0,
      JSON.stringify(conditions),
      body.skipDuplicateApprover ? 1 : 0,
      id
    );

    await audit(req, "update_workflow", "workflows", id, old, body);
    res.redirect(`/settings/workflows?id=${id}`);
  })
);

settingsRouter.post(
  "/settings/workflows/:id/default",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const workflow = asRow<Workflow>(await db.prepare("SELECT * FROM workflows WHERE id = ?").get(id));
    await db.prepare("UPDATE workflows SET is_default = 0 WHERE request_type = ?").run(workflow.request_type);
    await db.prepare("UPDATE workflows SET is_default = 1 WHERE id = ?").run(id);
    await audit(req, "set_default_workflow", "workflows", id, null, null);
    res.redirect(`/settings/workflows?id=${id}`);
  })
);

settingsRouter.post(
  "/settings/workflows/:id/steps",
  asyncHandler(async (req, res) => {
    const workflowId = Number(req.params.id);
    const body = req.body as Record<string, string>;
    const maxOrder = (await db
      .prepare("SELECT COALESCE(MAX(step_order), 0) as m FROM workflow_steps WHERE workflow_id = ?")
      .get(workflowId)) as { m: number };

    await db.prepare(
      `INSERT INTO workflow_steps (workflow_id, step_order, approver_type, approver_org_role, approver_user_id, sla_days, is_final)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).run(
      workflowId,
      maxOrder.m + 1,
      body.approverType as ApproverType,
      body.approverType === "org_role" ? (body.approverOrgRole as OrgRole) : null,
      body.approverType === "specific_user" ? Number(body.approverUserId) : null,
      Number(body.slaDays) || 2
    );

    // Only the last step is final.
    await db.prepare("UPDATE workflow_steps SET is_final = 0 WHERE workflow_id = ?").run(workflowId);
    await db.prepare(
      `UPDATE workflow_steps SET is_final = 1 WHERE workflow_id = ? AND step_order = (
         SELECT MAX(step_order) FROM workflow_steps WHERE workflow_id = ?
       )`
    ).run(workflowId, workflowId);

    await db.prepare("UPDATE workflows SET version = version + 1 WHERE id = ?").run(workflowId);
    await audit(req, "add_workflow_step", "workflow_steps", workflowId, null, body);
    res.redirect(`/settings/workflows?id=${workflowId}`);
  })
);

settingsRouter.post(
  "/settings/workflows/:id/steps/:stepId/delete",
  asyncHandler(async (req, res) => {
    const workflowId = Number(req.params.id);
    const stepId = Number(req.params.stepId);
    await db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);

    // Renumber remaining steps and re-mark the final one.
    const remaining = asRow<WorkflowStep[]>(
      await db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(workflowId)
    );
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      await db.prepare("UPDATE workflow_steps SET step_order = ?, is_final = ? WHERE id = ?").run(
        i + 1,
        i === remaining.length - 1 ? 1 : 0,
        s.id
      );
    }
    await db.prepare("UPDATE workflows SET version = version + 1 WHERE id = ?").run(workflowId);
    await audit(req, "delete_workflow_step", "workflow_steps", stepId, null, null);
    res.redirect(`/settings/workflows?id=${workflowId}`);
  })
);

settingsRouter.post(
  "/settings/workflows/:id/steps/:stepId/move",
  asyncHandler(async (req, res) => {
    const workflowId = Number(req.params.id);
    const stepId = Number(req.params.stepId);
    const direction = req.body.direction === "up" ? -1 : 1;

    const steps = asRow<WorkflowStep[]>(
      await db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(workflowId)
    );
    const idx = steps.findIndex((s) => s.id === stepId);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= steps.length) {
      res.redirect(`/settings/workflows?id=${workflowId}`);
      return;
    }
    const a = steps[idx];
    const b = steps[swapIdx];
    await db.prepare("UPDATE workflow_steps SET step_order = ? WHERE id = ?").run(b.step_order, a.id);
    await db.prepare("UPDATE workflow_steps SET step_order = ? WHERE id = ?").run(a.step_order, b.id);
    await db.prepare("UPDATE workflows SET version = version + 1 WHERE id = ?").run(workflowId);
    res.redirect(`/settings/workflows?id=${workflowId}`);
  })
);

// --- Leave carry-over ---------------------------------------------------

settingsRouter.get(
  "/settings/carry-over",
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const setting = asRow<CarryOverSetting | undefined>(
      await db.prepare("SELECT * FROM carry_over_settings WHERE scope = 'company' LIMIT 1").get()
    );
    res.render("settings/carry-over", { title: lang === "ar" ? "الإعدادات" : "Settings", lang, setting });
  })
);

settingsRouter.post(
  "/settings/carry-over",
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, string>;
    const old = await db.prepare("SELECT * FROM carry_over_settings WHERE scope = 'company' LIMIT 1").get();

    await db.prepare(
      `UPDATE carry_over_settings SET method = ?, max_days = ?, percentage = ?, percentage_cap_days = ?, expiry_months = ?
       WHERE scope = 'company'`
    ).run(
      body.method,
      body.maxDays ? Number(body.maxDays) : null,
      body.percentage ? Number(body.percentage) : null,
      body.percentageCapDays ? Number(body.percentageCapDays) : null,
      body.expiryMonths ? Number(body.expiryMonths) : null
    );
    await audit(req, "update_carry_over_settings", "carry_over_settings", null, old, body);
    res.redirect("/settings/carry-over");
  })
);

// --- Loan rules -----------------------------------------------------------

settingsRouter.get(
  "/settings/loan-rules",
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const defaults = asRow<LoanRule>(
      await db.prepare("SELECT * FROM loan_rules WHERE scope = 'company' LIMIT 1").get()
    );
    const overrides = await db
      .prepare(
        `SELECT lro.*, e.name_en, e.name_ar, e.employee_code, e.gross_salary
         FROM loan_rule_overrides lro JOIN employees e ON e.id = lro.employee_id
         ORDER BY e.name_en`
      )
      .all();
    const employees = asRow<Employee[]>(await db.prepare("SELECT * FROM employees ORDER BY name_en").all());

    res.render("settings/loan-rules", {
      title: lang === "ar" ? "الإعدادات" : "Settings",
      lang,
      defaults,
      overrides,
      employees,
    });
  })
);

settingsRouter.post(
  "/settings/loan-rules",
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, string>;
    const old = await db.prepare("SELECT * FROM loan_rules WHERE scope = 'company' LIMIT 1").get();

    await db.prepare(
      `UPDATE loan_rules SET max_amount = ?, max_months = ?, max_monthly_deduction = ?,
         max_monthly_deduction_is_percent = ?, max_simultaneous_loans = ?, waiting_period_months = ?, eligibility = ?
       WHERE scope = 'company'`
    ).run(
      body.maxAmount ? Number(body.maxAmount) : null,
      body.maxMonths ? Number(body.maxMonths) : null,
      body.maxMonthlyDeduction ? Number(body.maxMonthlyDeduction) : null,
      body.maxMonthlyDeductionIsPercent ? 1 : 0,
      body.maxSimultaneousLoans ? Number(body.maxSimultaneousLoans) : null,
      body.waitingPeriodMonths ? Number(body.waitingPeriodMonths) : null,
      body.eligibility || "allowed"
    );
    await audit(req, "update_loan_rules", "loan_rules", null, old, body);
    res.redirect("/settings/loan-rules");
  })
);

settingsRouter.post(
  "/settings/loan-rules/overrides",
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, string>;
    const employeeId = Number(body.employeeId);
    const existing = await db.prepare("SELECT id FROM loan_rule_overrides WHERE employee_id = ?").get(employeeId);

    const values = [
      body.maxAmount ? Number(body.maxAmount) : null,
      body.maxMonths ? Number(body.maxMonths) : null,
      body.maxMonthlyDeduction ? Number(body.maxMonthlyDeduction) : null,
      body.maxMonthlyDeductionIsPercent ? 1 : 0,
      body.maxSimultaneousLoans ? Number(body.maxSimultaneousLoans) : null,
      body.waitingPeriodMonths ? Number(body.waitingPeriodMonths) : null,
      body.eligibility || null,
      body.reason || null,
      req.session.user!.userId,
    ];

    if (existing) {
      await db.prepare(
        `UPDATE loan_rule_overrides SET max_amount=?, max_months=?, max_monthly_deduction=?,
           max_monthly_deduction_is_percent=?, max_simultaneous_loans=?, waiting_period_months=?,
           eligibility=?, reason=?, updated_by_user_id=?, updated_at=${NOW_SQL}
         WHERE employee_id = ?`
      ).run(...values, employeeId);
    } else {
      await db.prepare(
        `INSERT INTO loan_rule_overrides
          (employee_id, max_amount, max_months, max_monthly_deduction, max_monthly_deduction_is_percent,
           max_simultaneous_loans, waiting_period_months, eligibility, reason, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(employeeId, ...values);
    }
    await audit(req, "update_loan_rule_override", "loan_rule_overrides", employeeId, null, body);
    res.redirect("/settings/loan-rules");
  })
);

settingsRouter.post(
  "/settings/loan-rules/overrides/:employeeId/delete",
  asyncHandler(async (req, res) => {
    const employeeId = Number(req.params.employeeId);
    await db.prepare("DELETE FROM loan_rule_overrides WHERE employee_id = ?").run(employeeId);
    await audit(req, "delete_loan_rule_override", "loan_rule_overrides", employeeId, null, null);
    res.redirect("/settings/loan-rules");
  })
);

// --- Leave types ------------------------------------------------------------

settingsRouter.get(
  "/settings/leave-types",
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const leaveTypes = asRow<LeaveType[]>(await db.prepare("SELECT * FROM leave_types ORDER BY id").all());
    const entitlementRules = await db
      .prepare("SELECT * FROM leave_entitlement_rules ORDER BY min_years_service")
      .all();
    res.render("settings/leave-types", {
      title: lang === "ar" ? "الإعدادات" : "Settings",
      lang,
      leaveTypes,
      entitlementRules,
    });
  })
);

settingsRouter.post(
  "/settings/leave-types",
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, string>;
    await db.prepare(
      `INSERT INTO leave_types (name_en, name_ar, is_paid, annual_days, accrual_method, requires_attachment, allows_negative_balance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      body.nameEn,
      body.nameAr,
      body.isPaid ? 1 : 0,
      body.annualDays ? Number(body.annualDays) : null,
      body.accrualMethod || "upfront",
      body.requiresAttachment ? 1 : 0,
      body.allowsNegativeBalance ? 1 : 0
    );
    await audit(req, "create_leave_type", "leave_types", null, null, body);
    res.redirect("/settings/leave-types");
  })
);

settingsRouter.post(
  "/settings/leave-types/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body as Record<string, string>;
    await db.prepare(
      `UPDATE leave_types SET name_en=?, name_ar=?, is_paid=?, annual_days=?, requires_attachment=?, allows_negative_balance=?, is_active=?
       WHERE id = ?`
    ).run(
      body.nameEn,
      body.nameAr,
      body.isPaid ? 1 : 0,
      body.annualDays ? Number(body.annualDays) : null,
      body.requiresAttachment ? 1 : 0,
      body.allowsNegativeBalance ? 1 : 0,
      body.isActive ? 1 : 0,
      id
    );
    await audit(req, "update_leave_type", "leave_types", id, null, body);
    res.redirect("/settings/leave-types");
  })
);

settingsRouter.post(
  "/settings/leave-types/:id/toggle-active",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const current = (await db.prepare("SELECT is_active FROM leave_types WHERE id = ?").get(id)) as
      | { is_active: number }
      | undefined;
    if (!current) {
      res.redirect("/settings/leave-types");
      return;
    }
    await db.prepare("UPDATE leave_types SET is_active = ? WHERE id = ?").run(current.is_active ? 0 : 1, id);
    await audit(req, "toggle_leave_type_active", "leave_types", id, current, { is_active: current.is_active ? 0 : 1 });
    res.redirect("/settings/leave-types");
  })
);

settingsRouter.post(
  "/settings/entitlement-rules",
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, string>;
    await db.prepare("DELETE FROM leave_entitlement_rules").run();
    const years = ([] as string[]).concat(body.minYears as any);
    const days = ([] as string[]).concat(body.annualDays as any);
    for (let i = 0; i < years.length; i++) {
      const y = years[i];
      if (y === "" || y == null) continue;
      await db.prepare("INSERT INTO leave_entitlement_rules (min_years_service, annual_days) VALUES (?, ?)").run(
        Number(y),
        Number(days[i])
      );
    }
    await audit(req, "update_entitlement_rules", "leave_entitlement_rules", null, null, body);
    res.redirect("/settings/leave-types");
  })
);

// --- Holidays ----------------------------------------------------------------

settingsRouter.get(
  "/settings/holidays",
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const holidays = asRow<Holiday[]>(
      await db.prepare("SELECT * FROM holidays ORDER BY holiday_date").all()
    );
    res.render("settings/holidays", { title: lang === "ar" ? "الإعدادات" : "Settings", lang, holidays });
  })
);

settingsRouter.post(
  "/settings/holidays",
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, string>;
    await db.prepare("INSERT INTO holidays (holiday_date, name_en, name_ar) VALUES (?, ?, ?)").run(
      body.date,
      body.nameEn,
      body.nameAr
    );
    await audit(req, "create_holiday", "holidays", null, null, body);
    res.redirect("/settings/holidays");
  })
);

settingsRouter.post(
  "/settings/holidays/:id/delete",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await db.prepare("DELETE FROM holidays WHERE id = ?").run(id);
    await audit(req, "delete_holiday", "holidays", id, null, null);
    res.redirect("/settings/holidays");
  })
);

// --- Positions (reusable dropdown for job title, and later job-grade exceptions) ---

settingsRouter.get(
  "/settings/positions",
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const positions = await db.prepare("SELECT * FROM positions ORDER BY name_en").all();
    res.render("settings/positions", {
      title: lang === "ar" ? "الإعدادات" : "Settings",
      lang,
      positions,
    });
  })
);

settingsRouter.post(
  "/settings/positions",
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, string>;
    const inserted = (await db
      .prepare("INSERT INTO positions (name_en, name_ar) VALUES (?, ?) RETURNING id")
      .get(body.nameEn, body.nameAr)) as { id: number };
    await audit(req, "create_position", "positions", inserted.id, null, body);
    res.redirect("/settings/positions");
  })
);

settingsRouter.post(
  "/settings/positions/:id/delete",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await db.prepare("UPDATE positions SET is_active = 0 WHERE id = ?").run(id);
    await audit(req, "deactivate_position", "positions", id, null, null);
    res.redirect("/settings/positions");
  })
);

// --- Employees & users ---------------------------------------------------------

settingsRouter.get(
  "/settings/users",
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const employees = await db
      .prepare(
        `SELECT e.*, d.name_en as dept_en, d.name_ar as dept_ar, u.id as user_id, u.username, u.is_active as user_active
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN users u ON u.employee_id = e.id
         ORDER BY e.name_en`
      )
      .all();
    const departments = asRow<Department[]>(await db.prepare("SELECT * FROM departments ORDER BY name_en").all());
    const positions = await db.prepare("SELECT * FROM positions WHERE is_active = 1 ORDER BY name_en").all();
    res.render("settings/users", {
      title: lang === "ar" ? "الإعدادات" : "Settings",
      lang,
      employees,
      departments,
      positions,
      importResult: req.query.imported
        ? { created: Number(req.query.imported), errors: req.query.errors ? JSON.parse(String(req.query.errors)) : [] }
        : null,
      leaveBalanceImportResult: req.query.lbImported
        ? { updated: Number(req.query.lbImported), errors: req.query.lbErrors ? JSON.parse(String(req.query.lbErrors)) : [] }
        : null,
      loanImportResult: req.query.loanImported
        ? { created: Number(req.query.loanImported), errors: req.query.loanErrors ? JSON.parse(String(req.query.loanErrors)) : [] }
        : null,
      resetPassword: req.query.resetPassword ? String(req.query.resetPassword) : null,
    });
  })
);

settingsRouter.get(
  "/settings/users/:employeeId/edit",
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const employeeId = Number(req.params.employeeId);
    const employee = asRow<Employee | undefined>(
      await db.prepare("SELECT * FROM employees WHERE id = ?").get(employeeId)
    );
    if (!employee) {
      res.status(404).render("errors/404", { title: "Not found" });
      return;
    }
    const departments = asRow<Department[]>(await db.prepare("SELECT * FROM departments ORDER BY name_en").all());
    const positions = await db.prepare("SELECT * FROM positions WHERE is_active = 1 ORDER BY name_en").all();
    const employees = asRow<Employee[]>(
      await db.prepare("SELECT * FROM employees WHERE id != ? ORDER BY name_en").all(employeeId)
    );

    // Leave balance summary — same figures as Reports > Employee leave balances, computed for
    // just this one employee so HR can see the effect of an entitlement override immediately.
    const annualType = (await db.prepare("SELECT id FROM leave_types WHERE name_en = 'Annual leave'").get()) as
      | { id: number }
      | undefined;
    let balanceSummary: {
      fullYearEntitlement: number;
      accruedToDate: number;
      carriedOver: number;
      totalNow: number;
      totalUntilContractEnd: number;
    } | null = null;
    if (annualType) {
      const rules = await getEntitlementRules();
      const asOf = new Date().toISOString().slice(0, 10);
      const pending = await getPendingLeaveDays(employee.id, annualType.id);
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
        annualType.id,
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
      balanceSummary = {
        fullYearEntitlement: balance.fullYearEntitlement,
        accruedToDate: balance.accruedToDate,
        carriedOver: balance.carriedOver,
        totalNow: balance.carriedOver + balance.accruedToDate,
        totalUntilContractEnd: balance.carriedOver + balance.fullYearEntitlement,
      };
    }

    res.render("settings/edit-employee", {
      title: lang === "ar" ? "تعديل موظف" : "Edit employee",
      lang,
      employee,
      departments,
      positions,
      employees,
      balanceSummary,
      nationalities: NATIONALITIES,
      crTypes: CR_TYPES,
      sponsorshipTypes: SPONSORSHIP_TYPES,
      banks: SAUDI_BANKS,
    });
  })
);

settingsRouter.post(
  "/settings/users/:employeeId/edit",
  asyncHandler(async (req, res) => {
    const employeeId = Number(req.params.employeeId);
    const body = req.body as Record<string, string>;
    const old = await db.prepare("SELECT * FROM employees WHERE id = ?").get(employeeId);

    const salaryBasic = body.salaryBasic ? Number(body.salaryBasic) : null;
    const salaryHousing = body.salaryHousing ? Number(body.salaryHousing) : null;
    const salaryTransport = body.salaryTransport ? Number(body.salaryTransport) : null;
    const salaryOther = body.salaryOther ? Number(body.salaryOther) : null;
    const grossSalary = [salaryBasic, salaryHousing, salaryTransport, salaryOther].some((v) => v != null)
      ? (salaryBasic ?? 0) + (salaryHousing ?? 0) + (salaryTransport ?? 0) + (salaryOther ?? 0)
      : body.grossSalary
        ? Number(body.grossSalary)
        : null;

    const contractStartDate = body.contractStartDate || null;
    const contractPeriodMonths = body.contractPeriodMonths ? Number(body.contractPeriodMonths) : null;
    const contractEndDate =
      contractStartDate && contractPeriodMonths
        ? dayjs(contractStartDate).add(contractPeriodMonths, "month").format("YYYY-MM-DD")
        : null;

    await db.prepare(
      `UPDATE employees SET name_en=?, name_ar=?, department_id=?, job_title=?, job_grade=?,
         direct_manager_id=?, joining_date=?, gross_salary=?, status=?,
         date_of_birth=?, contract_start_date=?, contract_period_months=?, contract_end_date=?,
         salary_basic=?, salary_housing=?, salary_transport=?, salary_other=?,
         annual_leave_override=?, nationality=?, cr_type=?, sponsorship_type=?,
         bank_name=?, bank_branch_number=?, bank_iban=?, updated_at=${NOW_SQL}
       WHERE id = ?`
    ).run(
      body.nameEn,
      body.nameAr,
      body.departmentId ? Number(body.departmentId) : null,
      body.jobTitle || null,
      body.jobGrade || null,
      body.directManagerId ? Number(body.directManagerId) : null,
      body.joiningDate,
      grossSalary,
      body.status || "active",
      body.dateOfBirth || null,
      contractStartDate,
      contractPeriodMonths,
      contractEndDate,
      salaryBasic,
      salaryHousing,
      salaryTransport,
      salaryOther,
      body.annualLeaveOverride ? Number(body.annualLeaveOverride) : null,
      body.nationality || null,
      body.crType || null,
      body.sponsorshipType || null,
      body.bankName || null,
      body.bankBranchNumber || null,
      body.bankIban || null,
      employeeId
    );

    await audit(req, "update_employee", "employees", employeeId, old, body);
    res.redirect("/settings/users");
  })
);

settingsRouter.post(
  "/settings/users/:userId/reset-password",
  requireRole("system_admin"),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    const tempPassword = generateTemporaryPassword();
    const hash = await hashPassword(tempPassword);
    await db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL WHERE id = ?"
    ).run(hash, userId);
    await audit(req, "reset_password", "users", userId, null, null);
    res.redirect(`/settings/users?resetPassword=${encodeURIComponent(tempPassword)}&resetUserId=${userId}`);
  })
);

settingsRouter.post(
  "/settings/users/bulk-import",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.redirect("/settings/users");
      return;
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];

    const departments = asRow<Department[]>(await db.prepare("SELECT * FROM departments").all());
    const deptByName = new Map(departments.map((d) => [d.name_en.toLowerCase(), d.id]));

    let created = 0;
    const errors: string[] = [];

    const cellStr = (row: ExcelJS.Row, col: number) => String(row.getCell(col).value ?? "").trim();
    const cellDate = (row: ExcelJS.Row, col: number) => {
      const v = row.getCell(col).value;
      return v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").trim() || null;
    };
    const cellNum = (row: ExcelJS.Row, col: number) => {
      const v = row.getCell(col).value;
      return v === null || v === undefined || v === "" ? null : Number(v) || null;
    };

    // Column order, matching bulk-import-template.xlsx below:
    // 1 employee_code, 2 name_en, 3 name_ar, 4 department, 5 job_title, 6 job_grade,
    // 7 direct_manager_code, 8 joining_date, 9 date_of_birth, 10 nationality, 11 cr_type
    // (main/branch/optics), 12 sponsorship_type (company/other), 13 contract_start_date,
    // 14 contract_period_months, 15 salary_basic, 16 salary_housing, 17 salary_transport,
    // 18 salary_other, 19 bank_name, 20 bank_branch_number, 21 bank_iban, 22 create_account
    for (let i = 2; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const employeeCode = cellStr(row, 1);
      if (!employeeCode) continue;

      try {
        const nameEn = cellStr(row, 2);
        const nameAr = cellStr(row, 3);
        const deptName = cellStr(row, 4);
        const jobTitle = cellStr(row, 5);
        const jobGrade = cellStr(row, 6);
        const managerCode = cellStr(row, 7);
        const joiningDate = cellDate(row, 8);
        const dateOfBirth = cellDate(row, 9);
        const nationality = cellStr(row, 10) || null;
        const crType = cellStr(row, 11).toLowerCase() || null;
        const sponsorshipType = cellStr(row, 12).toLowerCase() || null;
        const contractStartDate = cellDate(row, 13);
        const contractPeriodMonths = cellNum(row, 14);
        const salaryBasic = cellNum(row, 15);
        const salaryHousing = cellNum(row, 16);
        const salaryTransport = cellNum(row, 17);
        const salaryOther = cellNum(row, 18);
        const bankName = cellStr(row, 19) || null;
        const bankBranchNumber = cellStr(row, 20) || null;
        const bankIban = cellStr(row, 21) || null;
        const createAccount = cellStr(row, 22).toLowerCase();

        if (!nameEn || !joiningDate) {
          errors.push(`Row ${i} (${employeeCode}): missing required name or joining date.`);
          continue;
        }
        if (crType && !["main", "branch", "optics"].includes(crType)) {
          errors.push(`Row ${i} (${employeeCode}): cr_type must be main/branch/optics, got "${crType}".`);
          continue;
        }
        if (sponsorshipType && !["company", "other"].includes(sponsorshipType)) {
          errors.push(`Row ${i} (${employeeCode}): sponsorship_type must be company/other, got "${sponsorshipType}".`);
          continue;
        }

        const existing = await db
          .prepare("SELECT id FROM employees WHERE employee_code = ?")
          .get(employeeCode);
        if (existing) {
          errors.push(`Row ${i} (${employeeCode}): employee code already exists, skipped.`);
          continue;
        }

        const departmentId = deptName ? deptByName.get(deptName.toLowerCase()) ?? null : null;
        const manager = managerCode
          ? ((await db.prepare("SELECT id FROM employees WHERE employee_code = ?").get(managerCode)) as
              | { id: number }
              | undefined)
          : null;

        const grossSalary = [salaryBasic, salaryHousing, salaryTransport, salaryOther].some((v) => v != null)
          ? (salaryBasic ?? 0) + (salaryHousing ?? 0) + (salaryTransport ?? 0) + (salaryOther ?? 0)
          : null;
        const contractEndDate =
          contractStartDate && contractPeriodMonths
            ? dayjs(contractStartDate).add(contractPeriodMonths, "month").format("YYYY-MM-DD")
            : null;

        const inserted = (await db
          .prepare(
            `INSERT INTO employees
              (employee_code, name_en, name_ar, department_id, job_title, job_grade, direct_manager_id,
               joining_date, gross_salary, status, date_of_birth, nationality, cr_type, sponsorship_type,
               contract_start_date, contract_period_months, contract_end_date,
               salary_basic, salary_housing, salary_transport, salary_other,
               bank_name, bank_branch_number, bank_iban)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
          )
          .get(
            employeeCode,
            nameEn,
            nameAr || nameEn,
            departmentId,
            jobTitle || null,
            jobGrade || null,
            manager?.id ?? null,
            joiningDate,
            grossSalary,
            dateOfBirth,
            nationality,
            crType,
            sponsorshipType,
            contractStartDate,
            contractPeriodMonths,
            contractEndDate,
            salaryBasic,
            salaryHousing,
            salaryTransport,
            salaryOther,
            bankName,
            bankBranchNumber,
            bankIban
          )) as { id: number };
        const newEmployeeId = inserted.id;

        if (createAccount === "yes" || createAccount === "y" || createAccount === "true") {
          const hash = await hashPassword(generateTemporaryPassword());
          await db.prepare(
            `INSERT INTO users (employee_id, username, password_hash, must_change_password, is_active)
             VALUES (?, ?, ?, 1, 1)`
          ).run(newEmployeeId, employeeCode, hash);
        }

        created++;
      } catch (err) {
        errors.push(`Row ${i} (${employeeCode}): ${(err as Error).message}`);
      }
    }

    await audit(req, "bulk_import_employees", "employees", null, null, { created, errorCount: errors.length });
    res.redirect(
      `/settings/users?imported=${created}&errors=${encodeURIComponent(JSON.stringify(errors.slice(0, 20)))}`
    );
  })
);

settingsRouter.get(
  "/settings/users/bulk-import-template.xlsx",
  asyncHandler(async (_req, res) => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Employees");
    sheet.columns = [
      { header: "employee_code", key: "code", width: 14 },
      { header: "name_en", key: "nameEn", width: 22 },
      { header: "name_ar", key: "nameAr", width: 22 },
      { header: "department", key: "dept", width: 16 },
      { header: "job_title", key: "jobTitle", width: 20 },
      { header: "job_grade", key: "jobGrade", width: 14 },
      { header: "direct_manager_code", key: "manager", width: 18 },
      { header: "joining_date", key: "joining", width: 14 },
      { header: "date_of_birth", key: "dob", width: 14 },
      { header: "nationality", key: "nationality", width: 16 },
      { header: "cr_type (main/branch/optics)", key: "crType", width: 22 },
      { header: "sponsorship_type (company/other)", key: "sponsorship", width: 24 },
      { header: "contract_start_date", key: "contractStart", width: 16 },
      { header: "contract_period_months", key: "contractMonths", width: 18 },
      { header: "salary_basic", key: "salaryBasic", width: 14 },
      { header: "salary_housing", key: "salaryHousing", width: 14 },
      { header: "salary_transport", key: "salaryTransport", width: 14 },
      { header: "salary_other", key: "salaryOther", width: 14 },
      { header: "bank_name", key: "bankName", width: 20 },
      { header: "bank_branch_number", key: "bankBranch", width: 16 },
      { header: "bank_iban", key: "bankIban", width: 24 },
      { header: "create_account", key: "createAccount", width: 14 },
    ];
    sheet.addRow({
      code: "RMC-2001",
      nameEn: "Example Employee",
      nameAr: "موظف مثال",
      dept: "Laboratory",
      jobTitle: "Lab Technician",
      jobGrade: "Staff",
      manager: "RMC-1000",
      joining: "2026-01-01",
      dob: "1990-06-15",
      nationality: "Saudi",
      crType: "main",
      sponsorship: "company",
      contractStart: "2026-01-01",
      contractMonths: 24,
      salaryBasic: 5000,
      salaryHousing: 1500,
      salaryTransport: 500,
      salaryOther: 0,
      bankName: "Al Rajhi Bank",
      bankBranch: "1234",
      bankIban: "SA0310000012345678901234",
      createAccount: "yes",
    });
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="employee-import-template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  })
);

// --- Historical data import: leave balances -----------------------------------

settingsRouter.post(
  "/settings/leave-balances/bulk-import",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.redirect("/settings/users");
      return;
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];

    const rules = await getEntitlementRules();
    const asOf = new Date().toISOString().slice(0, 10);
    let updated = 0;
    const errors: string[] = [];

    // Columns: employee_code, leave_type (optional, defaults to "Annual leave"),
    // carried_over, taken, manual_adjustment (optional, default 0)
    for (let i = 2; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const employeeCode = String(row.getCell(1).value ?? "").trim();
      if (!employeeCode) continue;

      try {
        const leaveTypeName = String(row.getCell(2).value ?? "").trim() || "Annual leave";
        const carriedOver = Number(row.getCell(3).value) || 0;
        const taken = Number(row.getCell(4).value) || 0;
        const manualAdjustment = Number(row.getCell(5).value) || 0;

        const employee = asRow<Employee | undefined>(
          await db.prepare("SELECT * FROM employees WHERE employee_code = ?").get(employeeCode)
        );
        if (!employee) {
          errors.push(`Row ${i} (${employeeCode}): no employee with this code.`);
          continue;
        }
        const leaveType = (await db
          .prepare("SELECT id FROM leave_types WHERE name_en = ?")
          .get(leaveTypeName)) as { id: number } | undefined;
        if (!leaveType) {
          errors.push(`Row ${i} (${employeeCode}): no leave type named "${leaveTypeName}".`);
          continue;
        }

        const { start, end } = leaveYearWindow(employee.joining_date, asOf);
        const entitlement =
          employee.annual_leave_override ?? resolveAnnualEntitlement(yearsOfService(employee.joining_date, asOf), rules);

        const existing = (await db
          .prepare(
            "SELECT id FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND leave_year_start = ?"
          )
          .get(employee.id, leaveType.id, start)) as { id: number } | undefined;

        if (existing) {
          await db.prepare(
            "UPDATE leave_balances SET entitlement = ?, carried_over = ?, taken = ?, manual_adjustment = ? WHERE id = ?"
          ).run(entitlement, carriedOver, taken, manualAdjustment, existing.id);
        } else {
          await db.prepare(
            `INSERT INTO leave_balances
              (employee_id, leave_type_id, leave_year_start, leave_year_end, entitlement, carried_over, taken, manual_adjustment)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(employee.id, leaveType.id, start, end, entitlement, carriedOver, taken, manualAdjustment);
        }

        updated++;
      } catch (err) {
        errors.push(`Row ${i} (${employeeCode}): ${(err as Error).message}`);
      }
    }

    await audit(req, "bulk_import_leave_balances", "leave_balances", null, null, { updated, errorCount: errors.length });
    res.redirect(
      `/settings/users?lbImported=${updated}&lbErrors=${encodeURIComponent(JSON.stringify(errors.slice(0, 20)))}`
    );
  })
);

settingsRouter.get(
  "/settings/leave-balances/bulk-import-template.xlsx",
  asyncHandler(async (_req, res) => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Leave balances");
    sheet.columns = [
      { header: "employee_code", key: "code", width: 14 },
      { header: "leave_type", key: "type", width: 18 },
      { header: "carried_over", key: "carried", width: 14 },
      { header: "taken", key: "taken", width: 10 },
      { header: "manual_adjustment", key: "adj", width: 18 },
    ];
    sheet.addRow({ code: "RMC-1042", type: "Annual leave", carried: 5, taken: 3, adj: 0 });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="leave-balance-import-template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  })
);

// --- Historical data import: existing/active loans -----------------------------

settingsRouter.post(
  "/settings/loans/bulk-import",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.redirect("/settings/users");
      return;
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];

    let created = 0;
    const errors: string[] = [];

    // Columns: employee_code, amount, months, first_deduction_month (YYYY-MM),
    // instalments_paid (count already deducted, counted from the first), reason (optional)
    for (let i = 2; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const employeeCode = String(row.getCell(1).value ?? "").trim();
      if (!employeeCode) continue;

      try {
        const amount = Number(row.getCell(2).value) || 0;
        const months = Number(row.getCell(3).value) || 0;
        const firstMonthRaw = row.getCell(4).value;
        const firstMonth =
          firstMonthRaw instanceof Date ? firstMonthRaw.toISOString().slice(0, 7) : String(firstMonthRaw ?? "").trim();
        const instalmentsPaid = Math.max(0, Math.min(months, Number(row.getCell(5).value) || 0));
        const reason = String(row.getCell(6).value ?? "").trim();

        if (!amount || !months || !firstMonth) {
          errors.push(`Row ${i} (${employeeCode}): missing amount, months, or first_deduction_month.`);
          continue;
        }

        const employee = asRow<Employee | undefined>(
          await db.prepare("SELECT * FROM employees WHERE employee_code = ?").get(employeeCode)
        );
        if (!employee) {
          errors.push(`Row ${i} (${employeeCode}): no employee with this code.`);
          continue;
        }

        const plan = planFromMonths(amount, months, firstMonth);
        const isClosed = instalmentsPaid >= months;
        const nowIso = new Date().toISOString();

        const inserted = (await db
          .prepare(
            `INSERT INTO loan_requests
              (employee_id, amount, reason, repayment_option, monthly_amount, months, first_deduction_month,
               terms_accepted, status, disbursed_at, closed_at)
             VALUES (?, ?, ?, 'months', ?, ?, ?, 1, ?, ?, ?) RETURNING id`
          )
          .get(
            employee.id,
            amount,
            reason || "Imported historical loan",
            plan.monthlyAmount,
            months,
            firstMonth,
            isClosed ? "closed" : "disbursed",
            nowIso,
            isClosed ? nowIso : null
          )) as { id: number };

        const insertInstalment = db.prepare(
          `INSERT INTO loan_instalments (loan_request_id, instalment_number, due_month, amount, status, deducted_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const entry of plan.schedule) {
          const paid = entry.instalmentNumber <= instalmentsPaid;
          await insertInstalment.run(
            inserted.id,
            entry.instalmentNumber,
            entry.dueMonth,
            entry.amount,
            paid ? "deducted" : "scheduled",
            paid ? nowIso : null
          );
        }

        created++;
      } catch (err) {
        errors.push(`Row ${i} (${employeeCode}): ${(err as Error).message}`);
      }
    }

    await audit(req, "bulk_import_loans", "loan_requests", null, null, { created, errorCount: errors.length });
    res.redirect(
      `/settings/users?loanImported=${created}&loanErrors=${encodeURIComponent(JSON.stringify(errors.slice(0, 20)))}`
    );
  })
);

settingsRouter.get(
  "/settings/loans/bulk-import-template.xlsx",
  asyncHandler(async (_req, res) => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Loans");
    sheet.columns = [
      { header: "employee_code", key: "code", width: 14 },
      { header: "amount", key: "amount", width: 14 },
      { header: "months", key: "months", width: 10 },
      { header: "first_deduction_month", key: "firstMonth", width: 20 },
      { header: "instalments_paid", key: "paid", width: 18 },
      { header: "reason", key: "reason", width: 24 },
    ];
    sheet.addRow({ code: "RMC-1042", amount: 6000, months: 6, firstMonth: "2026-01", paid: 2, reason: "Imported historical loan" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="loan-import-template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  })
);

settingsRouter.post(
  "/settings/users",
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, string>;

    const inserted = (await db
      .prepare(
        `INSERT INTO employees
          (employee_code, name_en, name_ar, department_id, job_title, job_grade, direct_manager_id, joining_date, gross_salary, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active') RETURNING id`
      )
      .get(
        body.employeeCode,
        body.nameEn,
        body.nameAr,
        body.departmentId ? Number(body.departmentId) : null,
        body.jobTitle || null,
        body.jobGrade || null,
        body.directManagerId ? Number(body.directManagerId) : null,
        body.joiningDate,
        body.grossSalary ? Number(body.grossSalary) : null
      )) as { id: number };
    const employeeId = inserted.id;

    if (body.createAccount) {
      const tempPassword = generateTemporaryPassword();
      const hash = await hashPassword(tempPassword);
      await db.prepare(
        `INSERT INTO users (employee_id, username, password_hash, must_change_password, is_active)
         VALUES (?, ?, ?, 1, 1)`
      ).run(employeeId, body.employeeCode, hash);
    }

    await audit(req, "create_employee", "employees", employeeId, null, body);
    res.redirect("/settings/users");
  })
);

settingsRouter.post(
  "/settings/users/:userId/toggle-active",
  requireRole("system_admin"),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    const user = (await db.prepare("SELECT is_active FROM users WHERE id = ?").get(userId)) as { is_active: number };
    await db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(user.is_active ? 0 : 1, userId);
    await audit(req, "toggle_user_active", "users", userId, null, null);
    res.redirect("/settings/users");
  })
);

settingsRouter.post(
  "/settings/users/:userId/unlock",
  requireRole("system_admin"),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    await db.prepare("UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE id = ?").run(userId);
    await audit(req, "unlock_user", "users", userId, null, null);
    res.redirect("/settings/users");
  })
);

// --- Audit log viewer (SC-12) ------------------------------------------------

settingsRouter.get(
  "/audit-log",
  requireRole("system_admin"),
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const logs = await db
      .prepare(
        `SELECT al.*, u.username
         FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
         ORDER BY al.id DESC LIMIT 200`
      )
      .all();
    res.render("settings/audit-log", { title: lang === "ar" ? "سجل التدقيق" : "Audit log", lang, logs });
  })
);

// --- Employee inquiry (استعلامات): look up one employee's full picture by code ---------

settingsRouter.get(
  "/employee-inquiry",
  requireAuth,
  requireRole("hr_officer", "system_admin"),
  asyncHandler(async (req, res) => {
    const lang = req.session.user!.language;
    const code = String(req.query.code || "").trim();

    let employee: Employee | null = null;
    let department: { name_en: string; name_ar: string } | null = null;
    let balanceSummary: {
      fullYearEntitlement: number;
      accruedToDate: number;
      carriedOver: number;
      taken: number;
      pending: number;
      remaining: number;
      totalNow: number;
      totalUntilContractEnd: number;
    } | null = null;
    let leaveHistory: unknown[] = [];
    let loanHistory: unknown[] = [];
    let notFound = false;

    if (code) {
      const found = asRow<Employee | undefined>(
        await db.prepare("SELECT * FROM employees WHERE employee_code = ?").get(code)
      );
      if (!found) {
        notFound = true;
      } else {
        employee = found;
        department = employee.department_id
          ? ((await db.prepare("SELECT name_en, name_ar FROM departments WHERE id = ?").get(employee.department_id)) as
              | { name_en: string; name_ar: string }
              | null)
          : null;

        const annualType = (await db.prepare("SELECT id FROM leave_types WHERE name_en = 'Annual leave'").get()) as
          | { id: number }
          | undefined;
        if (annualType) {
          const rules = await getEntitlementRules();
          const asOf = new Date().toISOString().slice(0, 10);
          const pending = await getPendingLeaveDays(employee.id, annualType.id);
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
            annualType.id,
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
          balanceSummary = {
            fullYearEntitlement: balance.fullYearEntitlement,
            accruedToDate: balance.accruedToDate,
            carriedOver: balance.carriedOver,
            taken: balance.taken,
            pending: balance.pending,
            remaining: balance.remaining,
            totalNow: balance.carriedOver + balance.accruedToDate,
            totalUntilContractEnd: balance.carriedOver + balance.fullYearEntitlement,
          };
        }

        leaveHistory = await db
          .prepare(
            `SELECT lr.*, lt.name_en as type_name_en, lt.name_ar as type_name_ar
             FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.employee_id = ? ORDER BY lr.created_at DESC`
          )
          .all(employee.id);

        loanHistory = await db
          .prepare("SELECT * FROM loan_requests WHERE employee_id = ? ORDER BY created_at DESC")
          .all(employee.id);
      }
    }

    res.render("settings/employee-inquiry", {
      title: lang === "ar" ? "استعلامات" : "Employee inquiry",
      lang,
      code,
      employee,
      department,
      balanceSummary,
      leaveHistory,
      loanHistory,
      notFound,
    });
  })
);
