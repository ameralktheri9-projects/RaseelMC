import { pool } from "./index";
import { runMigrations } from "./migrate";
import { hashPassword } from "../utils/password";

async function seed(): Promise<void> {
  await runMigrations();

  const existingAdmin = await pool.query("SELECT id FROM users WHERE username = $1", ["admin"]);
  if (existingAdmin.rows[0]) {
    console.log("Seed data already present, skipping.");
    return;
  }

  // Run the whole seed as one transaction on a single checked-out client — pool.query() alone
  // can hand different calls to different pooled connections, which would break BEGIN/COMMIT.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const id = async (sql: string, params: unknown[]): Promise<number> => {
      const r = await client.query(sql, params);
      return r.rows[0].id as number;
    };
    const run = async (sql: string, params: unknown[] = []): Promise<void> => {
      await client.query(sql, params);
    };

    // Departments
    const deptAdmin = await id("INSERT INTO departments (name_en, name_ar) VALUES ($1, $2) RETURNING id", ["Administration", "الإدارة"]);
    const deptLab = await id("INSERT INTO departments (name_en, name_ar) VALUES ($1, $2) RETURNING id", ["Laboratory", "المختبر"]);
    const deptFinance = await id("INSERT INTO departments (name_en, name_ar) VALUES ($1, $2) RETURNING id", ["Finance", "المالية"]);

    // Leave entitlement rules (LV-02)
    await run("INSERT INTO leave_entitlement_rules (min_years_service, annual_days) VALUES ($1, $2)", [0, 21]);
    await run("INSERT INTO leave_entitlement_rules (min_years_service, annual_days) VALUES ($1, $2)", [5, 30]);

    // Leave types
    const insertLeaveTypeSql = `INSERT INTO leave_types (name_en, name_ar, is_paid, annual_days, accrual_method, requires_attachment, allows_negative_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;
    const ltAnnual = await id(insertLeaveTypeSql, ["Annual leave", "إجازة سنوية", 1, null, "monthly", 0, 0]);
    await run(insertLeaveTypeSql, ["Sick leave", "إجازة مرضية", 1, 30, "upfront", 1, 0]);
    await run(insertLeaveTypeSql, ["Emergency leave", "إجازة طارئة", 1, 5, "upfront", 0, 0]);
    await run(insertLeaveTypeSql, ["Marriage leave", "إجازة زواج", 1, 5, "upfront", 0, 0]);
    await run(insertLeaveTypeSql, ["Bereavement leave", "إجازة وفاة", 1, 5, "upfront", 0, 0]);
    await run(insertLeaveTypeSql, ["Maternity leave", "إجازة أمومة", 1, 70, "upfront", 0, 0]);
    await run(insertLeaveTypeSql, ["Unpaid leave", "إجازة بدون راتب", 0, null, "upfront", 0, 1]);

    // Carry-over setting (company default, from BRD worked example: 10 days max)
    await run(
      `INSERT INTO carry_over_settings (scope, method, max_days, expiry_months, rounding)
       VALUES ('company', 'days', 10, 3, 'down')`
    );

    // Loan rules (company default)
    await run(
      `INSERT INTO loan_rules (scope, max_amount, max_months, max_monthly_deduction, max_monthly_deduction_is_percent, max_simultaneous_loans, waiting_period_months, eligibility)
       VALUES ('company', NULL, NULL, 10, 1, NULL, NULL, 'allowed')`
    );

    // Sample holidays (Saudi national day + a couple examples)
    const insertHolidaySql = "INSERT INTO holidays (holiday_date, name_en, name_ar) VALUES ($1, $2, $3)";
    await run(insertHolidaySql, ["2026-09-23", "Saudi National Day", "اليوم الوطني السعودي"]);
    await run(insertHolidaySql, ["2027-02-22", "Founding Day", "يوم التأسيس"]);

    // Employees
    const insertEmployeeSql = `INSERT INTO employees
        (employee_code, name_en, name_ar, department_id, job_title, job_grade, direct_manager_id, joining_date, gross_salary, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active') RETURNING id`;

    const ceoId = await id(insertEmployeeSql, [
      "RMC-0001", "Dr. Abdullah Al-Rashid", "د. عبدالله الراشد",
      deptAdmin, "Chief Executive Officer", "Executive", null, "2015-01-01", 45000,
    ]);

    const hrManagerId = await id(insertEmployeeSql, [
      "RMC-0002", "Sara Al-Dosari", "سارة الدوسري",
      deptAdmin, "HR Manager", "Manager", ceoId, "2017-03-10", 18000,
    ]);

    const financeManagerId = await id(insertEmployeeSql, [
      "RMC-0003", "Majed Al-Zahrani", "ماجد الزهراني",
      deptFinance, "Finance Manager", "Manager", ceoId, "2018-06-01", 19000,
    ]);

    const labHeadId = await id(insertEmployeeSql, [
      "RMC-1000", "Khalid Al-Otaibi", "خالد العتيبي",
      deptLab, "Laboratory Head", "Supervisor", ceoId, "2016-02-15", 14000,
    ]);

    const faisalId = await id(insertEmployeeSql, [
      "RMC-1042", "Faisal Al-Qahtani", "فيصل القحطاني",
      deptLab, "Lab Technician", "Staff", labHeadId, "2024-03-15", 8000,
    ]);

    const hudaId = await id(insertEmployeeSql, [
      "RMC-1043", "Huda Al-Mutairi", "هدى المطيري",
      deptLab, "Lab Technician", "Staff", labHeadId, "2022-07-01", 7500,
    ]);

    // Department heads
    await run("UPDATE departments SET head_employee_id = $1 WHERE id = $2", [hrManagerId, deptAdmin]);
    await run("UPDATE departments SET head_employee_id = $1 WHERE id = $2", [labHeadId, deptLab]);
    await run("UPDATE departments SET head_employee_id = $1 WHERE id = $2", [financeManagerId, deptFinance]);

    // Org role assignments (used by WF-03 "Role" approver steps)
    const insertOrgRoleSql = "INSERT INTO org_role_assignments (org_role, employee_id) VALUES ($1, $2)";
    await run(insertOrgRoleSql, ["hr_manager", hrManagerId]);
    await run(insertOrgRoleSql, ["finance_manager", financeManagerId]);
    await run(insertOrgRoleSql, ["ceo", ceoId]);

    // Users (accounts). Default temp password for all seeded accounts: "Welcome123" (must change at first login).
    const tempHash = await hashPassword("Welcome123");
    const insertUserSql = `INSERT INTO users (employee_id, username, password_hash, must_change_password, language, is_active)
       VALUES ($1, $2, $3, 1, 'en', 1) RETURNING id`;
    const adminUserId = await id(insertUserSql, [null, "admin", await hashPassword("Admin123!")]);
    await run(insertUserSql, [ceoId, "RMC-0001", tempHash]);
    const hrUserId = await id(insertUserSql, [hrManagerId, "RMC-0002", tempHash]);
    const financeUserId = await id(insertUserSql, [financeManagerId, "RMC-0003", tempHash]);
    await run(insertUserSql, [labHeadId, "RMC-1000", tempHash]);
    await run(insertUserSql, [faisalId, "RMC-1042", tempHash]);
    await run(insertUserSql, [hudaId, "RMC-1043", tempHash]);

    // Admin user keeps must_change_password = 0 so it's immediately usable.
    await run("UPDATE users SET must_change_password = 0 WHERE id = $1", [adminUserId]);

    const insertUserRoleSql = "INSERT INTO user_roles (user_id, role) VALUES ($1, $2)";
    await run(insertUserRoleSql, [adminUserId, "system_admin"]);
    await run(insertUserRoleSql, [hrUserId, "hr_officer"]);
    await run(insertUserRoleSql, [financeUserId, "finance"]);

    // Default approval workflows (BRD 5.2)
    const insertWorkflowSql = `INSERT INTO workflows (name_en, name_ar, request_type, is_active, is_default, conditions_json)
       VALUES ($1, $2, $3, 1, $4, $5) RETURNING id`;
    const insertStepSql = `INSERT INTO workflow_steps (workflow_id, step_order, approver_type, approver_org_role, is_final, sla_days)
       VALUES ($1, $2, $3, $4, $5, $6)`;

    // Annual leave - standard (<=10 days)
    const wfAnnualStandard = await id(insertWorkflowSql, [
      "Annual leave - standard", "إجازة سنوية - عادية", "leave", 0, JSON.stringify({ leaveTypeId: ltAnnual, maxDays: 10 }),
    ]);
    await run(insertStepSql, [wfAnnualStandard, 1, "direct_manager", null, 0, 2]);
    await run(insertStepSql, [wfAnnualStandard, 2, "org_role", "hr_manager", 1, 2]);

    // Annual leave - long (>10 days)
    const wfAnnualLong = await id(insertWorkflowSql, [
      "Annual leave - long", "إجازة سنوية - طويلة", "leave", 0, JSON.stringify({ leaveTypeId: ltAnnual, minDays: 11 }),
    ]);
    await run(insertStepSql, [wfAnnualLong, 1, "direct_manager", null, 0, 2]);
    await run(insertStepSql, [wfAnnualLong, 2, "department_head", null, 0, 2]);
    await run(insertStepSql, [wfAnnualLong, 3, "org_role", "hr_manager", 1, 2]);

    // Sick / emergency leave
    const wfSick = await id(insertWorkflowSql, [
      "Sick / emergency leave", "إجازة مرضية / طارئة", "leave", 0, JSON.stringify({}),
    ]);
    await run(insertStepSql, [wfSick, 1, "direct_manager", null, 0, 2]);
    await run(insertStepSql, [wfSick, 2, "org_role", "hr_manager", 1, 2]);

    // Loan - standard (<= SAR 10,000)
    const wfLoanStandard = await id(insertWorkflowSql, [
      "Loan - standard", "سلفة - عادية", "loan", 0, JSON.stringify({ maxAmount: 10000 }),
    ]);
    await run(insertStepSql, [wfLoanStandard, 1, "direct_manager", null, 0, 2]);
    await run(insertStepSql, [wfLoanStandard, 2, "org_role", "hr_manager", 0, 2]);
    await run(insertStepSql, [wfLoanStandard, 3, "org_role", "finance_manager", 1, 2]);

    // Loan - high value (> SAR 10,000)
    const wfLoanHigh = await id(insertWorkflowSql, [
      "Loan - high value", "سلفة - مبلغ مرتفع", "loan", 0, JSON.stringify({ minAmount: 10000.01 }),
    ]);
    await run(insertStepSql, [wfLoanHigh, 1, "direct_manager", null, 0, 2]);
    await run(insertStepSql, [wfLoanHigh, 2, "org_role", "hr_manager", 0, 2]);
    await run(insertStepSql, [wfLoanHigh, 3, "org_role", "finance_manager", 0, 2]);
    await run(insertStepSql, [wfLoanHigh, 4, "org_role", "ceo", 1, 3]);

    // Mark one workflow per request type as the mandatory default fallback (WF-05)
    await run("UPDATE workflows SET is_default = 1 WHERE id = $1", [wfAnnualStandard]);
    await run("UPDATE workflows SET is_default = 1 WHERE id = $1", [wfLoanStandard]);

    await client.query("COMMIT");
    console.log("Seed data inserted successfully.");
    console.log("Admin login: username 'admin', password 'Admin123!'");
    console.log("Other seeded users: username = employee code (e.g. 'RMC-1042'), password 'Welcome123' (must change at first login).");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seed()
    .then(() => {
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { seed };
