import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { db, asRow } from "../db";
import { config } from "../config";
import { requireAuth, requireEmployee } from "../middleware/auth";
import { t } from "../i18n";
import {
  computeLeaveBalance,
  getEntitlementRules,
  getHolidays,
  getOrCreateLeaveBalanceRow,
  getPendingLeaveDays,
  workingDaysBetween,
} from "../services/leaveCalculationService";
import { submitRequest, getApprovalTrail } from "../services/workflowEngine";
import type { Employee, LeaveType, LeaveRequest } from "../models/types";

export const leaveRouter = Router();

fs.mkdirSync(path.join(process.cwd(), config.attachmentsDir), { recursive: true });

const upload = multer({
  dest: path.join(process.cwd(), config.attachmentsDir),
  limits: { fileSize: config.maxAttachmentBytes },
  fileFilter: (_req, file, cb) => {
    const ok = ["application/pdf", "image/jpeg", "image/jpg"].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error("Only PDF or JPG attachments are allowed."));
  },
});

function currentEmployee(req: any): Employee {
  return asRow<Employee>(
    db.prepare("SELECT * FROM employees WHERE id = ?").get(req.session.user.employeeId)
  );
}

leaveRouter.get("/leave", requireAuth, requireEmployee, (req, res) => {
  const lang = req.session.user!.language;
  const employee = currentEmployee(req);

  const requests = db
    .prepare(
      `SELECT lr.*, lt.name_en as type_name_en, lt.name_ar as type_name_ar
       FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.employee_id = ?
       ORDER BY lr.created_at DESC`
    )
    .all(employee.id);

  res.render("leave/index", { title: t(lang, "nav.myLeave"), lang, requests });
});

leaveRouter.get("/leave/new", requireAuth, requireEmployee, (req, res) => {
  const lang = req.session.user!.language;
  const employee = currentEmployee(req);

  const leaveTypes = asRow<LeaveType[]>(
    db.prepare("SELECT * FROM leave_types WHERE is_active = 1 ORDER BY id").all()
  );
  const colleagues = db
    .prepare(
      `SELECT id, name_en, name_ar, job_title FROM employees
       WHERE department_id = ? AND id != ? AND status = 'active' ORDER BY name_en`
    )
    .all(employee.department_id, employee.id);

  res.render("leave/new", {
    title: t(lang, "nav.myLeave"),
    lang,
    employee,
    leaveTypes,
    colleagues,
    error: null,
    form: {},
  });
});

leaveRouter.post("/leave/new", requireAuth, requireEmployee, upload.single("attachment"), async (req, res) => {
  const lang = req.session.user!.language;
  const employee = currentEmployee(req);
  const sessionUser = req.session.user!;

  const { leaveTypeId, startDate, endDate, reason, handoverEmployeeId } = req.body as Record<string, string>;

  const leaveTypes = asRow<LeaveType[]>(
    db.prepare("SELECT * FROM leave_types WHERE is_active = 1 ORDER BY id").all()
  );
  const colleagues = db
    .prepare(
      `SELECT id, name_en, name_ar, job_title FROM employees
       WHERE department_id = ? AND id != ? AND status = 'active' ORDER BY name_en`
    )
    .all(employee.department_id, employee.id);

  const renderError = (message: string) =>
    res.status(400).render("leave/new", {
      title: t(lang, "nav.myLeave"),
      lang,
      employee,
      leaveTypes,
      colleagues,
      error: message,
      form: req.body,
    });

  const leaveType = asRow<LeaveType | undefined>(
    db.prepare("SELECT * FROM leave_types WHERE id = ?").get(Number(leaveTypeId))
  );
  if (!leaveType) {
    renderError(lang === "ar" ? "نوع الإجازة غير صالح." : "Invalid leave type.");
    return;
  }
  if (!startDate || !endDate || startDate > endDate) {
    renderError(lang === "ar" ? "نطاق التاريخ غير صالح." : "Invalid date range.");
    return;
  }

  // LV-12: attachment mandatory for sick leave
  if (leaveType.requires_attachment && !req.file) {
    renderError(
      lang === "ar"
        ? "المرفق مطلوب لهذا النوع من الإجازة."
        : "An attachment is required for this leave type."
    );
    return;
  }

  const holidays = getHolidays();
  const workingDays = workingDaysBetween(startDate, endDate, holidays);
  if (workingDays <= 0) {
    renderError(
      lang === "ar"
        ? "لا توجد أيام عمل ضمن هذا النطاق (عطلات نهاية الأسبوع/الإجازات الرسمية)."
        : "No working days fall within this range (weekends/holidays only)."
    );
    return;
  }

  // LV-13: block overlapping requests (pending or approved) for this employee
  const overlap = db
    .prepare(
      `SELECT COUNT(*) as n FROM leave_requests
       WHERE employee_id = ? AND status IN ('pending','approved')
       AND NOT (end_date < ? OR start_date > ?)`
    )
    .get(employee.id, startDate, endDate) as { n: number };
  if (overlap.n > 0) {
    renderError(
      lang === "ar"
        ? "تتداخل هذه التواريخ مع طلب إجازة آخر."
        : "These dates overlap with another leave request."
    );
    return;
  }

  // LV-11: block requests above balance unless the leave type allows negative balance
  if (leaveType.name_en === "Annual leave") {
    const rules = getEntitlementRules();
    const asOf = new Date().toISOString().slice(0, 10);
    const pending = getPendingLeaveDays(employee.id, leaveType.id);
    const prelim = computeLeaveBalance({
      employee,
      asOf,
      entitlementRules: rules,
      carriedOver: 0,
      taken: 0,
      pending,
      manualAdjustment: 0,
    });
    const balanceRow = getOrCreateLeaveBalanceRow(
      employee.id,
      leaveType.id,
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
    if (!leaveType.allows_negative_balance && workingDays > balance.remaining) {
      renderError(
        lang === "ar"
          ? `الرصيد غير كافٍ. المتاح ${balance.remaining} يوم فقط.`
          : `Insufficient balance. Only ${balance.remaining} days available.`
      );
      return;
    }
  }

  const insert = db.prepare(
    `INSERT INTO leave_requests
      (employee_id, leave_type_id, start_date, end_date, working_days, reason, handover_employee_id, attachment_path, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
  );
  const result = insert.run(
    employee.id,
    leaveType.id,
    startDate,
    endDate,
    workingDays,
    reason || null,
    handoverEmployeeId ? Number(handoverEmployeeId) : null,
    req.file ? req.file.filename : null
  );
  const requestId = Number(result.lastInsertRowid);

  try {
    submitRequest("leave", requestId, employee, { leaveTypeId: leaveType.id, days: workingDays });
  } catch (err) {
    renderError((err as Error).message);
    return;
  }

  db.prepare(
    `INSERT INTO audit_log (user_id, action, record_type, record_id, new_value_json, ip_address)
     VALUES (?, 'submit_leave_request', 'leave_requests', ?, ?, ?)`
  ).run(sessionUser.userId, requestId, JSON.stringify(req.body), req.ip ?? null);

  res.redirect("/leave");
});

leaveRouter.post("/leave/:id/cancel", requireAuth, requireEmployee, (req, res) => {
  const employee = currentEmployee(req);
  const id = Number(req.params.id);

  const request = asRow<LeaveRequest | undefined>(
    db.prepare("SELECT * FROM leave_requests WHERE id = ? AND employee_id = ?").get(id, employee.id)
  );
  if (!request) {
    res.status(404).send("Not found");
    return;
  }

  if (request.status === "pending" || request.status === "returned") {
    db.prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id = ?").run(id);
  } else if (request.status === "approved") {
    // LV-15: cancelling an approved future leave sends a cancellation request through the same workflow.
    const insertResult = db
      .prepare(
        `INSERT INTO leave_requests
          (employee_id, leave_type_id, start_date, end_date, working_days, reason, is_cancellation_of, status)
         VALUES (?, ?, ?, ?, ?, 'Cancellation request', ?, 'draft')`
      )
      .run(employee.id, request.leave_type_id, request.start_date, request.end_date, request.working_days, id);
    const newId = Number(insertResult.lastInsertRowid);
    submitRequest("leave", newId, employee, { leaveTypeId: request.leave_type_id, days: request.working_days });
  }

  res.redirect("/leave");
});

leaveRouter.get("/leave/:id", requireAuth, requireEmployee, (req, res) => {
  const lang = req.session.user!.language;
  const employee = currentEmployee(req);
  const id = Number(req.params.id);

  const request = db
    .prepare(
      `SELECT lr.*, lt.name_en as type_name_en, lt.name_ar as type_name_ar
       FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.id = ? AND lr.employee_id = ?`
    )
    .get(id, employee.id);

  if (!request) {
    res.status(404).render("errors/404", { title: "Not found" });
    return;
  }

  const trail = getApprovalTrail("leave", id);
  res.render("leave/detail", { title: t(lang, "nav.myLeave"), lang, request, trail });
});
