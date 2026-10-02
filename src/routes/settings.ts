import { Router } from "express";
import { db, asRow } from "../db";
import { requireAuth, requireRole } from "../middleware/auth";
import { hashPassword, generateTemporaryPassword } from "../utils/password";
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

export const settingsRouter = Router();

// Scoped to this router's actual path prefixes only — an unscoped .use() here would otherwise
// gate every request that falls through to it (e.g. /notifications/recent for a non-admin user),
// since Express runs a path-less router.use() for any request reaching the router at all.
settingsRouter.use(["/settings", "/audit-log"], requireAuth, requireRole("hr_officer", "system_admin"));

function audit(req: any, action: string, recordType: string, recordId: number | null, oldVal: any, newVal: any) {
  db.prepare(
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

settingsRouter.get("/settings/workflows", (req, res) => {
  const lang = req.session.user!.language;
  const workflows = asRow<Workflow[]>(
    db.prepare("SELECT * FROM workflows ORDER BY request_type, is_default DESC, id").all()
  );
  const selectedId = req.query.id ? Number(req.query.id) : workflows[0]?.id;
  const selected = workflows.find((w) => w.id === selectedId) ?? null;
  const steps = selected
    ? asRow<WorkflowStep[]>(
        db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(selected.id)
      )
    : [];
  const employees = asRow<Employee[]>(db.prepare("SELECT * FROM employees ORDER BY name_en").all());
  const users = db.prepare("SELECT id, username, employee_id FROM users WHERE is_active = 1").all();

  res.render("settings/workflows", {
    title: lang === "ar" ? "الإعدادات" : "Settings",
    lang,
    workflows,
    selected,
    steps,
    employees,
    users,
  });
});

settingsRouter.post("/settings/workflows", (req, res) => {
  const { nameEn, nameAr, requestType } = req.body as Record<string, string>;
  const result = db
    .prepare(
      `INSERT INTO workflows (name_en, name_ar, request_type, is_active, is_default, conditions_json)
       VALUES (?, ?, ?, 1, 0, '{}')`
    )
    .run(nameEn, nameAr, requestType);
  audit(req, "create_workflow", "workflows", Number(result.lastInsertRowid), null, req.body);
  res.redirect(`/settings/workflows?id=${result.lastInsertRowid}`);
});

settingsRouter.post("/settings/workflows/:id", (req, res) => {
  const id = Number(req.params.id);
  const body = req.body as Record<string, string>;
  const old = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);

  const conditions: Record<string, number> = {};
  if (body.condMinDays) conditions.minDays = Number(body.condMinDays);
  if (body.condMaxDays) conditions.maxDays = Number(body.condMaxDays);
  if (body.condMinAmount) conditions.minAmount = Number(body.condMinAmount);
  if (body.condMaxAmount) conditions.maxAmount = Number(body.condMaxAmount);
  if (body.condDepartmentId) conditions.departmentId = Number(body.condDepartmentId);
  if (body.condLeaveTypeId) conditions.leaveTypeId = Number(body.condLeaveTypeId);

  // Editing bumps the version so in-flight requests keep the version they started with (WF-10).
  db.prepare(
    `UPDATE workflows SET name_en = ?, name_ar = ?, is_active = ?, conditions_json = ?,
       skip_duplicate_approver = ?, version = version + 1, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    body.nameEn,
    body.nameAr,
    body.isActive ? 1 : 0,
    JSON.stringify(conditions),
    body.skipDuplicateApprover ? 1 : 0,
    id
  );

  audit(req, "update_workflow", "workflows", id, old, body);
  res.redirect(`/settings/workflows?id=${id}`);
});

settingsRouter.post("/settings/workflows/:id/default", (req, res) => {
  const id = Number(req.params.id);
  const workflow = asRow<Workflow>(db.prepare("SELECT * FROM workflows WHERE id = ?").get(id));
  db.prepare("UPDATE workflows SET is_default = 0 WHERE request_type = ?").run(workflow.request_type);
  db.prepare("UPDATE workflows SET is_default = 1 WHERE id = ?").run(id);
  audit(req, "set_default_workflow", "workflows", id, null, null);
  res.redirect(`/settings/workflows?id=${id}`);
});

settingsRouter.post("/settings/workflows/:id/steps", (req, res) => {
  const workflowId = Number(req.params.id);
  const body = req.body as Record<string, string>;
  const maxOrder = db
    .prepare("SELECT COALESCE(MAX(step_order), 0) as m FROM workflow_steps WHERE workflow_id = ?")
    .get(workflowId) as { m: number };

  db.prepare(
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
  db.prepare("UPDATE workflow_steps SET is_final = 0 WHERE workflow_id = ?").run(workflowId);
  db.prepare(
    `UPDATE workflow_steps SET is_final = 1 WHERE workflow_id = ? AND step_order = (
       SELECT MAX(step_order) FROM workflow_steps WHERE workflow_id = ?
     )`
  ).run(workflowId, workflowId);

  db.prepare("UPDATE workflows SET version = version + 1 WHERE id = ?").run(workflowId);
  audit(req, "add_workflow_step", "workflow_steps", workflowId, null, body);
  res.redirect(`/settings/workflows?id=${workflowId}`);
});

settingsRouter.post("/settings/workflows/:id/steps/:stepId/delete", (req, res) => {
  const workflowId = Number(req.params.id);
  const stepId = Number(req.params.stepId);
  db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);

  // Renumber remaining steps and re-mark the final one.
  const remaining = asRow<WorkflowStep[]>(
    db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(workflowId)
  );
  remaining.forEach((s, i) => {
    db.prepare("UPDATE workflow_steps SET step_order = ?, is_final = ? WHERE id = ?").run(
      i + 1,
      i === remaining.length - 1 ? 1 : 0,
      s.id
    );
  });
  db.prepare("UPDATE workflows SET version = version + 1 WHERE id = ?").run(workflowId);
  audit(req, "delete_workflow_step", "workflow_steps", stepId, null, null);
  res.redirect(`/settings/workflows?id=${workflowId}`);
});

settingsRouter.post("/settings/workflows/:id/steps/:stepId/move", (req, res) => {
  const workflowId = Number(req.params.id);
  const stepId = Number(req.params.stepId);
  const direction = req.body.direction === "up" ? -1 : 1;

  const steps = asRow<WorkflowStep[]>(
    db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(workflowId)
  );
  const idx = steps.findIndex((s) => s.id === stepId);
  const swapIdx = idx + direction;
  if (idx < 0 || swapIdx < 0 || swapIdx >= steps.length) {
    res.redirect(`/settings/workflows?id=${workflowId}`);
    return;
  }
  const a = steps[idx];
  const b = steps[swapIdx];
  db.prepare("UPDATE workflow_steps SET step_order = ? WHERE id = ?").run(b.step_order, a.id);
  db.prepare("UPDATE workflow_steps SET step_order = ? WHERE id = ?").run(a.step_order, b.id);
  db.prepare("UPDATE workflows SET version = version + 1 WHERE id = ?").run(workflowId);
  res.redirect(`/settings/workflows?id=${workflowId}`);
});

// --- Leave carry-over ---------------------------------------------------

settingsRouter.get("/settings/carry-over", (req, res) => {
  const lang = req.session.user!.language;
  const setting = asRow<CarryOverSetting | undefined>(
    db.prepare("SELECT * FROM carry_over_settings WHERE scope = 'company' LIMIT 1").get()
  );
  res.render("settings/carry-over", { title: lang === "ar" ? "الإعدادات" : "Settings", lang, setting });
});

settingsRouter.post("/settings/carry-over", (req, res) => {
  const body = req.body as Record<string, string>;
  const old = db.prepare("SELECT * FROM carry_over_settings WHERE scope = 'company' LIMIT 1").get();

  db.prepare(
    `UPDATE carry_over_settings SET method = ?, max_days = ?, percentage = ?, percentage_cap_days = ?, expiry_months = ?
     WHERE scope = 'company'`
  ).run(
    body.method,
    body.maxDays ? Number(body.maxDays) : null,
    body.percentage ? Number(body.percentage) : null,
    body.percentageCapDays ? Number(body.percentageCapDays) : null,
    body.expiryMonths ? Number(body.expiryMonths) : null
  );
  audit(req, "update_carry_over_settings", "carry_over_settings", null, old, body);
  res.redirect("/settings/carry-over");
});

// --- Loan rules -----------------------------------------------------------

settingsRouter.get("/settings/loan-rules", (req, res) => {
  const lang = req.session.user!.language;
  const defaults = asRow<LoanRule>(
    db.prepare("SELECT * FROM loan_rules WHERE scope = 'company' LIMIT 1").get()
  );
  const overrides = db
    .prepare(
      `SELECT lro.*, e.name_en, e.name_ar, e.employee_code, e.gross_salary
       FROM loan_rule_overrides lro JOIN employees e ON e.id = lro.employee_id
       ORDER BY e.name_en`
    )
    .all();
  const employees = asRow<Employee[]>(db.prepare("SELECT * FROM employees ORDER BY name_en").all());

  res.render("settings/loan-rules", {
    title: lang === "ar" ? "الإعدادات" : "Settings",
    lang,
    defaults,
    overrides,
    employees,
  });
});

settingsRouter.post("/settings/loan-rules", (req, res) => {
  const body = req.body as Record<string, string>;
  const old = db.prepare("SELECT * FROM loan_rules WHERE scope = 'company' LIMIT 1").get();

  db.prepare(
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
  audit(req, "update_loan_rules", "loan_rules", null, old, body);
  res.redirect("/settings/loan-rules");
});

settingsRouter.post("/settings/loan-rules/overrides", (req, res) => {
  const body = req.body as Record<string, string>;
  const employeeId = Number(body.employeeId);
  const existing = db.prepare("SELECT id FROM loan_rule_overrides WHERE employee_id = ?").get(employeeId);

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
    db.prepare(
      `UPDATE loan_rule_overrides SET max_amount=?, max_months=?, max_monthly_deduction=?,
         max_monthly_deduction_is_percent=?, max_simultaneous_loans=?, waiting_period_months=?,
         eligibility=?, reason=?, updated_by_user_id=?, updated_at=datetime('now')
       WHERE employee_id = ?`
    ).run(...values, employeeId);
  } else {
    db.prepare(
      `INSERT INTO loan_rule_overrides
        (employee_id, max_amount, max_months, max_monthly_deduction, max_monthly_deduction_is_percent,
         max_simultaneous_loans, waiting_period_months, eligibility, reason, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(employeeId, ...values);
  }
  audit(req, "update_loan_rule_override", "loan_rule_overrides", employeeId, null, body);
  res.redirect("/settings/loan-rules");
});

settingsRouter.post("/settings/loan-rules/overrides/:employeeId/delete", (req, res) => {
  const employeeId = Number(req.params.employeeId);
  db.prepare("DELETE FROM loan_rule_overrides WHERE employee_id = ?").run(employeeId);
  audit(req, "delete_loan_rule_override", "loan_rule_overrides", employeeId, null, null);
  res.redirect("/settings/loan-rules");
});

// --- Leave types ------------------------------------------------------------

settingsRouter.get("/settings/leave-types", (req, res) => {
  const lang = req.session.user!.language;
  const leaveTypes = asRow<LeaveType[]>(db.prepare("SELECT * FROM leave_types ORDER BY id").all());
  const entitlementRules = db
    .prepare("SELECT * FROM leave_entitlement_rules ORDER BY min_years_service")
    .all();
  res.render("settings/leave-types", {
    title: lang === "ar" ? "الإعدادات" : "Settings",
    lang,
    leaveTypes,
    entitlementRules,
  });
});

settingsRouter.post("/settings/leave-types", (req, res) => {
  const body = req.body as Record<string, string>;
  db.prepare(
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
  audit(req, "create_leave_type", "leave_types", null, null, body);
  res.redirect("/settings/leave-types");
});

settingsRouter.post("/settings/leave-types/:id", (req, res) => {
  const id = Number(req.params.id);
  const body = req.body as Record<string, string>;
  db.prepare(
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
  audit(req, "update_leave_type", "leave_types", id, null, body);
  res.redirect("/settings/leave-types");
});

settingsRouter.post("/settings/entitlement-rules", (req, res) => {
  const body = req.body as Record<string, string>;
  db.prepare("DELETE FROM leave_entitlement_rules").run();
  const years = [].concat(body.minYears as any);
  const days = [].concat(body.annualDays as any);
  years.forEach((y: string, i: number) => {
    if (y === "" || y == null) return;
    db.prepare("INSERT INTO leave_entitlement_rules (min_years_service, annual_days) VALUES (?, ?)").run(
      Number(y),
      Number(days[i])
    );
  });
  audit(req, "update_entitlement_rules", "leave_entitlement_rules", null, null, body);
  res.redirect("/settings/leave-types");
});

// --- Holidays ----------------------------------------------------------------

settingsRouter.get("/settings/holidays", (req, res) => {
  const lang = req.session.user!.language;
  const holidays = asRow<Holiday[]>(
    db.prepare("SELECT * FROM holidays ORDER BY holiday_date").all()
  );
  res.render("settings/holidays", { title: lang === "ar" ? "الإعدادات" : "Settings", lang, holidays });
});

settingsRouter.post("/settings/holidays", (req, res) => {
  const body = req.body as Record<string, string>;
  db.prepare("INSERT INTO holidays (holiday_date, name_en, name_ar) VALUES (?, ?, ?)").run(
    body.date,
    body.nameEn,
    body.nameAr
  );
  audit(req, "create_holiday", "holidays", null, null, body);
  res.redirect("/settings/holidays");
});

settingsRouter.post("/settings/holidays/:id/delete", (req, res) => {
  const id = Number(req.params.id);
  db.prepare("DELETE FROM holidays WHERE id = ?").run(id);
  audit(req, "delete_holiday", "holidays", id, null, null);
  res.redirect("/settings/holidays");
});

// --- Employees & users ---------------------------------------------------------

settingsRouter.get("/settings/users", (req, res) => {
  const lang = req.session.user!.language;
  const employees = db
    .prepare(
      `SELECT e.*, d.name_en as dept_en, d.name_ar as dept_ar, u.id as user_id, u.username, u.is_active as user_active
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN users u ON u.employee_id = e.id
       ORDER BY e.name_en`
    )
    .all();
  const departments = asRow<Department[]>(db.prepare("SELECT * FROM departments ORDER BY name_en").all());
  res.render("settings/users", {
    title: lang === "ar" ? "الإعدادات" : "Settings",
    lang,
    employees,
    departments,
  });
});

settingsRouter.post("/settings/users", async (req, res) => {
  const body = req.body as Record<string, string>;

  const result = db
    .prepare(
      `INSERT INTO employees
        (employee_code, name_en, name_ar, department_id, job_title, job_grade, direct_manager_id, joining_date, gross_salary, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    )
    .run(
      body.employeeCode,
      body.nameEn,
      body.nameAr,
      body.departmentId ? Number(body.departmentId) : null,
      body.jobTitle || null,
      body.jobGrade || null,
      body.directManagerId ? Number(body.directManagerId) : null,
      body.joiningDate,
      body.grossSalary ? Number(body.grossSalary) : null
    );
  const employeeId = Number(result.lastInsertRowid);

  if (body.createAccount) {
    const tempPassword = generateTemporaryPassword();
    const hash = await hashPassword(tempPassword);
    db.prepare(
      `INSERT INTO users (employee_id, username, password_hash, must_change_password, is_active)
       VALUES (?, ?, ?, 1, 1)`
    ).run(employeeId, body.employeeCode, hash);
  }

  audit(req, "create_employee", "employees", employeeId, null, body);
  res.redirect("/settings/users");
});

settingsRouter.post("/settings/users/:userId/toggle-active", requireRole("system_admin"), (req, res) => {
  const userId = Number(req.params.userId);
  const user = db.prepare("SELECT is_active FROM users WHERE id = ?").get(userId) as { is_active: number };
  db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(user.is_active ? 0 : 1, userId);
  audit(req, "toggle_user_active", "users", userId, null, null);
  res.redirect("/settings/users");
});

settingsRouter.post("/settings/users/:userId/unlock", requireRole("system_admin"), (req, res) => {
  const userId = Number(req.params.userId);
  db.prepare("UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE id = ?").run(userId);
  audit(req, "unlock_user", "users", userId, null, null);
  res.redirect("/settings/users");
});

// --- Audit log viewer (SC-12) ------------------------------------------------

settingsRouter.get("/audit-log", requireRole("system_admin"), (req, res) => {
  const lang = req.session.user!.language;
  const logs = db
    .prepare(
      `SELECT al.*, u.username
       FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
       ORDER BY al.id DESC LIMIT 200`
    )
    .all();
  res.render("settings/audit-log", { title: lang === "ar" ? "سجل التدقيق" : "Audit log", lang, logs });
});
