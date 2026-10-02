import { Router } from "express";
import ExcelJS from "exceljs";
import { db, asRow } from "../db";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  computeLeaveBalance,
  getEntitlementRules,
  getOrCreateLeaveBalanceRow,
  getPendingLeaveDays,
} from "../services/leaveCalculationService";
import type { Employee } from "../models/types";

export const reportsRouter = Router();

reportsRouter.use(requireAuth, requireRole("hr_officer", "finance", "system_admin"));

reportsRouter.get("/reports", (req, res) => {
  const lang = req.session.user!.language;
  res.render("reports/index", { title: lang === "ar" ? "التقارير" : "Reports", lang });
});

async function sendWorkbook(res: any, filename: string, build: (wb: ExcelJS.Workbook) => void) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

// 1. Leave balance by employee / department
reportsRouter.get("/reports/leave-balance.xlsx", requireRole("hr_officer", "system_admin"), async (_req, res) => {
  const employees = asRow<Employee[]>(
    db.prepare("SELECT * FROM employees WHERE status = 'active' ORDER BY name_en").all()
  );
  const annualType = db.prepare("SELECT id FROM leave_types WHERE name_en = 'Annual leave'").get() as { id: number };
  const rules = getEntitlementRules();
  const asOf = new Date().toISOString().slice(0, 10);

  await sendWorkbook(res, "leave-balance.xlsx", (wb) => {
    const sheet = wb.addWorksheet("Leave balance");
    sheet.columns = [
      { header: "Employee code", key: "code", width: 14 },
      { header: "Name", key: "name", width: 24 },
      { header: "Department", key: "dept", width: 18 },
      { header: "Full-year entitlement", key: "ent", width: 20 },
      { header: "Accrued to date", key: "accrued", width: 16 },
      { header: "Carried over", key: "carried", width: 14 },
      { header: "Taken", key: "taken", width: 10 },
      { header: "Pending", key: "pending", width: 10 },
      { header: "Remaining", key: "remaining", width: 12 },
    ];
    for (const emp of employees) {
      const dept = emp.department_id
        ? (db.prepare("SELECT name_en FROM departments WHERE id = ?").get(emp.department_id) as any)
        : null;
      const pending = getPendingLeaveDays(emp.id, annualType.id);
      const prelim = computeLeaveBalance({
        employee: emp,
        asOf,
        entitlementRules: rules,
        carriedOver: 0,
        taken: 0,
        pending,
        manualAdjustment: 0,
      });
      const row = getOrCreateLeaveBalanceRow(emp.id, annualType.id, prelim.leaveYearStart, prelim.leaveYearEnd, prelim.fullYearEntitlement);
      const balance = computeLeaveBalance({
        employee: emp,
        asOf,
        entitlementRules: rules,
        carriedOver: row.carried_over,
        taken: row.taken,
        pending,
        manualAdjustment: row.manual_adjustment,
      });
      sheet.addRow({
        code: emp.employee_code,
        name: emp.name_en,
        dept: dept?.name_en ?? "",
        ent: balance.fullYearEntitlement,
        accrued: balance.accruedToDate,
        carried: balance.carriedOver,
        taken: balance.taken,
        pending: balance.pending,
        remaining: balance.remaining,
      });
    }
  });
});

// 2. Leave taken by period and type
reportsRouter.get("/reports/leave-taken.xlsx", async (_req, res) => {
  const rows = db
    .prepare(
      `SELECT e.employee_code, e.name_en, lt.name_en as leave_type, lr.start_date, lr.end_date, lr.working_days, lr.status
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.status = 'approved'
       ORDER BY lr.start_date DESC`
    )
    .all();

  await sendWorkbook(res, "leave-taken.xlsx", (wb) => {
    const sheet = wb.addWorksheet("Leave taken");
    sheet.columns = [
      { header: "Employee code", key: "code", width: 14 },
      { header: "Name", key: "name", width: 24 },
      { header: "Leave type", key: "type", width: 18 },
      { header: "Start", key: "start", width: 12 },
      { header: "End", key: "end", width: 12 },
      { header: "Days", key: "days", width: 10 },
    ];
    for (const r of rows as any[]) {
      sheet.addRow({ code: r.employee_code, name: r.name_en, type: r.leave_type, start: r.start_date, end: r.end_date, days: r.working_days });
    }
  });
});

// 3. Pending approvals and ageing
reportsRouter.get("/reports/pending-approvals.xlsx", requireRole("hr_officer", "system_admin"), async (_req, res) => {
  const leave = db
    .prepare(
      `SELECT 'leave' as kind, e.employee_code, e.name_en, lr.current_step_order, lr.created_at
       FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.status = 'pending'`
    )
    .all() as any[];
  const loan = db
    .prepare(
      `SELECT 'loan' as kind, e.employee_code, e.name_en, lo.current_step_order, lo.created_at
       FROM loan_requests lo JOIN employees e ON e.id = lo.employee_id WHERE lo.status = 'pending'`
    )
    .all() as any[];

  await sendWorkbook(res, "pending-approvals.xlsx", (wb) => {
    const sheet = wb.addWorksheet("Pending approvals");
    sheet.columns = [
      { header: "Type", key: "kind", width: 10 },
      { header: "Employee code", key: "code", width: 14 },
      { header: "Name", key: "name", width: 24 },
      { header: "Current step", key: "step", width: 12 },
      { header: "Submitted", key: "created", width: 20 },
      { header: "Age (days)", key: "age", width: 12 },
    ];
    for (const r of [...leave, ...loan]) {
      const ageDays = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000);
      sheet.addRow({ kind: r.kind, code: r.employee_code, name: r.name_en, step: r.current_step_order, created: r.created_at, age: ageDays });
    }
  });
});

// 4. Active loans and outstanding balances
reportsRouter.get("/reports/active-loans.xlsx", requireRole("finance", "system_admin"), async (_req, res) => {
  const loans = db
    .prepare(
      `SELECT e.employee_code, e.name_en, lo.amount, lo.monthly_amount, lo.months, lo.status,
              (SELECT COALESCE(SUM(amount), 0) FROM loan_instalments WHERE loan_request_id = lo.id AND status = 'deducted') as paid
       FROM loan_requests lo JOIN employees e ON e.id = lo.employee_id
       WHERE lo.status IN ('approved','disbursed')
       ORDER BY lo.created_at DESC`
    )
    .all();

  await sendWorkbook(res, "active-loans.xlsx", (wb) => {
    const sheet = wb.addWorksheet("Active loans");
    sheet.columns = [
      { header: "Employee code", key: "code", width: 14 },
      { header: "Name", key: "name", width: 24 },
      { header: "Amount", key: "amount", width: 12 },
      { header: "Monthly", key: "monthly", width: 12 },
      { header: "Months", key: "months", width: 10 },
      { header: "Paid", key: "paid", width: 12 },
      { header: "Outstanding", key: "outstanding", width: 14 },
      { header: "Status", key: "status", width: 12 },
    ];
    for (const r of loans as any[]) {
      sheet.addRow({
        code: r.employee_code,
        name: r.name_en,
        amount: r.amount,
        monthly: r.monthly_amount,
        months: r.months,
        paid: r.paid,
        outstanding: r.amount - r.paid,
        status: r.status,
      });
    }
  });
});

// 5. Monthly payroll deduction schedule
reportsRouter.get("/reports/deduction-schedule.xlsx", requireRole("finance", "system_admin"), async (req, res) => {
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const instalments = db
    .prepare(
      `SELECT e.employee_code, e.name_en, li.instalment_number, li.amount, li.status
       FROM loan_instalments li
       JOIN loan_requests lo ON lo.id = li.loan_request_id
       JOIN employees e ON e.id = lo.employee_id
       WHERE li.due_month = ? AND lo.status IN ('disbursed','closed')
       ORDER BY e.name_en`
    )
    .all(month);

  await sendWorkbook(res, `deduction-schedule-${month}.xlsx`, (wb) => {
    const sheet = wb.addWorksheet(`Deductions ${month}`);
    sheet.columns = [
      { header: "Employee code", key: "code", width: 14 },
      { header: "Name", key: "name", width: 24 },
      { header: "Instalment #", key: "num", width: 14 },
      { header: "Amount (SAR)", key: "amount", width: 14 },
      { header: "Status", key: "status", width: 12 },
    ];
    for (const r of instalments as any[]) {
      sheet.addRow({ code: r.employee_code, name: r.name_en, num: r.instalment_number, amount: r.amount, status: r.status });
    }
  });
});

// 6. Audit log export
reportsRouter.get("/reports/audit-log.xlsx", requireRole("system_admin"), async (_req, res) => {
  const logs = db
    .prepare(
      `SELECT al.*, u.username FROM audit_log al LEFT JOIN users u ON u.id = al.user_id ORDER BY al.id DESC LIMIT 5000`
    )
    .all();

  await sendWorkbook(res, "audit-log.xlsx", (wb) => {
    const sheet = wb.addWorksheet("Audit log");
    sheet.columns = [
      { header: "User", key: "user", width: 16 },
      { header: "Action", key: "action", width: 28 },
      { header: "Record type", key: "recordType", width: 18 },
      { header: "Record ID", key: "recordId", width: 12 },
      { header: "IP", key: "ip", width: 16 },
      { header: "Timestamp", key: "ts", width: 20 },
    ];
    for (const l of logs as any[]) {
      sheet.addRow({ user: l.username, action: l.action, recordType: l.record_type, recordId: l.record_id, ip: l.ip_address, ts: l.created_at });
    }
  });
});
