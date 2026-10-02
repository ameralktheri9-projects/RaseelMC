import { db } from "./index";
import { runMigrations } from "./migrate";
import { hashPassword } from "../utils/password";

async function seed(): Promise<void> {
  runMigrations();

  const existingAdmin = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
  if (existingAdmin) {
    console.log("Seed data already present, skipping.");
    return;
  }

  db.exec("BEGIN");
  try {
    // Departments
    const insertDept = db.prepare(
      "INSERT INTO departments (name_en, name_ar) VALUES (?, ?)"
    );
    const deptAdmin = insertDept.run("Administration", "الإدارة").lastInsertRowid as number;
    const deptLab = insertDept.run("Laboratory", "المختبر").lastInsertRowid as number;
    const deptFinance = insertDept.run("Finance", "المالية").lastInsertRowid as number;

    // Leave entitlement rules (LV-02)
    db.prepare(
      "INSERT INTO leave_entitlement_rules (min_years_service, annual_days) VALUES (?, ?)"
    ).run(0, 21);
    db.prepare(
      "INSERT INTO leave_entitlement_rules (min_years_service, annual_days) VALUES (?, ?)"
    ).run(5, 30);

    // Leave types
    const insertLeaveType = db.prepare(
      `INSERT INTO leave_types (name_en, name_ar, is_paid, annual_days, accrual_method, requires_attachment, allows_negative_balance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const ltAnnual = insertLeaveType.run("Annual leave", "إجازة سنوية", 1, null, "monthly", 0, 0)
      .lastInsertRowid as number;
    insertLeaveType.run("Sick leave", "إجازة مرضية", 1, 30, "upfront", 1, 0);
    insertLeaveType.run("Emergency leave", "إجازة طارئة", 1, 5, "upfront", 0, 0);
    insertLeaveType.run("Marriage leave", "إجازة زواج", 1, 5, "upfront", 0, 0);
    insertLeaveType.run("Bereavement leave", "إجازة وفاة", 1, 5, "upfront", 0, 0);
    insertLeaveType.run("Maternity leave", "إجازة أمومة", 1, 70, "upfront", 0, 0);
    insertLeaveType.run("Unpaid leave", "إجازة بدون راتب", 0, null, "upfront", 0, 1);

    // Carry-over setting (company default, from BRD worked example: 10 days max)
    db.prepare(
      `INSERT INTO carry_over_settings (scope, method, max_days, expiry_months, rounding)
       VALUES ('company', 'days', 10, 3, 'down')`
    ).run();

    // Loan rules (company default)
    db.prepare(
      `INSERT INTO loan_rules (scope, max_amount, max_months, max_monthly_deduction, max_monthly_deduction_is_percent, max_simultaneous_loans, waiting_period_months, eligibility)
       VALUES ('company', NULL, NULL, 10, 1, NULL, NULL, 'allowed')`
    ).run();

    // Sample holidays (Saudi national day + a couple examples)
    const insertHoliday = db.prepare(
      "INSERT INTO holidays (holiday_date, name_en, name_ar) VALUES (?, ?, ?)"
    );
    insertHoliday.run("2026-09-23", "Saudi National Day", "اليوم الوطني السعودي");
    insertHoliday.run("2027-02-22", "Founding Day", "يوم التأسيس");

    // Employees
    const insertEmployee = db.prepare(
      `INSERT INTO employees
        (employee_code, name_en, name_ar, department_id, job_title, job_grade, direct_manager_id, joining_date, gross_salary, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    );

    const ceoId = insertEmployee.run(
      "RMC-0001", "Dr. Abdullah Al-Rashid", "د. عبدالله الراشد",
      deptAdmin, "Chief Executive Officer", "Executive", null, "2015-01-01", 45000
    ).lastInsertRowid as number;

    const hrManagerId = insertEmployee.run(
      "RMC-0002", "Sara Al-Dosari", "سارة الدوسري",
      deptAdmin, "HR Manager", "Manager", ceoId, "2017-03-10", 18000
    ).lastInsertRowid as number;

    const financeManagerId = insertEmployee.run(
      "RMC-0003", "Majed Al-Zahrani", "ماجد الزهراني",
      deptFinance, "Finance Manager", "Manager", ceoId, "2018-06-01", 19000
    ).lastInsertRowid as number;

    const labHeadId = insertEmployee.run(
      "RMC-1000", "Khalid Al-Otaibi", "خالد العتيبي",
      deptLab, "Laboratory Head", "Supervisor", ceoId, "2016-02-15", 14000
    ).lastInsertRowid as number;

    const faisalId = insertEmployee.run(
      "RMC-1042", "Faisal Al-Qahtani", "فيصل القحطاني",
      deptLab, "Lab Technician", "Staff", labHeadId, "2024-03-15", 8000
    ).lastInsertRowid as number;

    const hudaId = insertEmployee.run(
      "RMC-1043", "Huda Al-Mutairi", "هدى المطيري",
      deptLab, "Lab Technician", "Staff", labHeadId, "2022-07-01", 7500
    ).lastInsertRowid as number;

    // Department heads
    db.prepare("UPDATE departments SET head_employee_id = ? WHERE id = ?").run(deptAdmin === deptAdmin ? hrManagerId : null, deptAdmin);
    db.prepare("UPDATE departments SET head_employee_id = ? WHERE id = ?").run(labHeadId, deptLab);
    db.prepare("UPDATE departments SET head_employee_id = ? WHERE id = ?").run(financeManagerId, deptFinance);

    // Org role assignments (used by WF-03 "Role" approver steps)
    const insertOrgRole = db.prepare(
      "INSERT INTO org_role_assignments (org_role, employee_id) VALUES (?, ?)"
    );
    insertOrgRole.run("hr_manager", hrManagerId);
    insertOrgRole.run("finance_manager", financeManagerId);
    insertOrgRole.run("ceo", ceoId);

    // Users (accounts). Default temp password for all seeded accounts: "Welcome123" (must change at first login).
    const tempHash = await hashPassword("Welcome123");
    const insertUser = db.prepare(
      `INSERT INTO users (employee_id, username, password_hash, must_change_password, language, is_active)
       VALUES (?, ?, ?, 1, 'en', 1)`
    );
    const adminUserId = insertUser.run(null, "admin", await hashPassword("Admin123!")).lastInsertRowid as number;
    insertUser.run(ceoId, "RMC-0001", tempHash);
    const hrUserId = insertUser.run(hrManagerId, "RMC-0002", tempHash).lastInsertRowid as number;
    const financeUserId = insertUser.run(financeManagerId, "RMC-0003", tempHash).lastInsertRowid as number;
    insertUser.run(labHeadId, "RMC-1000", tempHash);
    insertUser.run(faisalId, "RMC-1042", tempHash);
    insertUser.run(hudaId, "RMC-1043", tempHash);

    // Admin user keeps must_change_password = 0 so it's immediately usable.
    db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(adminUserId);

    const insertUserRole = db.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, ?)");
    insertUserRole.run(adminUserId, "system_admin");
    insertUserRole.run(hrUserId, "hr_officer");
    insertUserRole.run(financeUserId, "finance");

    // Default approval workflows (BRD 5.2)
    const insertWorkflow = db.prepare(
      `INSERT INTO workflows (name_en, name_ar, request_type, is_active, is_default, conditions_json)
       VALUES (?, ?, ?, 1, ?, ?)`
    );
    const insertStep = db.prepare(
      `INSERT INTO workflow_steps (workflow_id, step_order, approver_type, approver_org_role, is_final, sla_days)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    // Annual leave - standard (<=10 days)
    const wfAnnualStandard = insertWorkflow.run(
      "Annual leave - standard", "إجازة سنوية - عادية", "leave", 0, JSON.stringify({ leaveTypeId: ltAnnual, maxDays: 10 })
    ).lastInsertRowid as number;
    insertStep.run(wfAnnualStandard, 1, "direct_manager", null, 0, 2);
    insertStep.run(wfAnnualStandard, 2, "org_role", "hr_manager", 1, 2);

    // Annual leave - long (>10 days)
    const wfAnnualLong = insertWorkflow.run(
      "Annual leave - long", "إجازة سنوية - طويلة", "leave", 0, JSON.stringify({ leaveTypeId: ltAnnual, minDays: 11 })
    ).lastInsertRowid as number;
    insertStep.run(wfAnnualLong, 1, "direct_manager", null, 0, 2);
    insertStep.run(wfAnnualLong, 2, "department_head", null, 0, 2);
    insertStep.run(wfAnnualLong, 3, "org_role", "hr_manager", 1, 2);

    // Sick / emergency leave
    const wfSick = insertWorkflow.run(
      "Sick / emergency leave", "إجازة مرضية / طارئة", "leave", 0, JSON.stringify({})
    ).lastInsertRowid as number;
    insertStep.run(wfSick, 1, "direct_manager", null, 0, 2);
    insertStep.run(wfSick, 2, "org_role", "hr_manager", 1, 2);

    // Loan - standard (<= SAR 10,000)
    const wfLoanStandard = insertWorkflow.run(
      "Loan - standard", "سلفة - عادية", "loan", 0, JSON.stringify({ maxAmount: 10000 })
    ).lastInsertRowid as number;
    insertStep.run(wfLoanStandard, 1, "direct_manager", null, 0, 2);
    insertStep.run(wfLoanStandard, 2, "org_role", "hr_manager", 0, 2);
    insertStep.run(wfLoanStandard, 3, "org_role", "finance_manager", 1, 2);

    // Loan - high value (> SAR 10,000)
    const wfLoanHigh = insertWorkflow.run(
      "Loan - high value", "سلفة - مبلغ مرتفع", "loan", 0, JSON.stringify({ minAmount: 10000.01 })
    ).lastInsertRowid as number;
    insertStep.run(wfLoanHigh, 1, "direct_manager", null, 0, 2);
    insertStep.run(wfLoanHigh, 2, "org_role", "hr_manager", 0, 2);
    insertStep.run(wfLoanHigh, 3, "org_role", "finance_manager", 0, 2);
    insertStep.run(wfLoanHigh, 4, "org_role", "ceo", 1, 3);

    // Mark one workflow per request type as the mandatory default fallback (WF-05)
    db.prepare("UPDATE workflows SET is_default = 1 WHERE id = ?").run(wfAnnualStandard);
    db.prepare("UPDATE workflows SET is_default = 1 WHERE id = ?").run(wfLoanStandard);

    db.exec("COMMIT");
    console.log("Seed data inserted successfully.");
    console.log("Admin login: username 'admin', password 'Admin123!'");
    console.log("Other seeded users: username = employee code (e.g. 'RMC-1042'), password 'Welcome123' (must change at first login).");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { seed };
