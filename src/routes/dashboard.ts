import { Router } from "express";
import { db, asRow } from "../db";
import { requireAuth } from "../middleware/auth";
import { t } from "../i18n";
import {
  computeLeaveBalance,
  getEntitlementRules,
  getOrCreateLeaveBalanceRow,
  getPendingLeaveDays,
} from "../services/leaveCalculationService";
import type { Employee, LeaveType } from "../models/types";

export const dashboardRouter = Router();

dashboardRouter.get("/", (req, res) => {
  res.redirect(req.session.user ? "/dashboard" : "/login");
});

dashboardRouter.get("/dashboard", requireAuth, (req, res) => {
  const sessionUser = req.session.user!;
  const lang = sessionUser.language;

  if (!sessionUser.employeeId) {
    // System admin with no linked employee record: show a minimal admin landing.
    res.render("dashboard", {
      title: t(lang, "nav.dashboard"),
      lang,
      employee: null,
      balance: null,
      leaveType: null,
    });
    return;
  }

  const employee = asRow<Employee>(
    db.prepare("SELECT * FROM employees WHERE id = ?").get(sessionUser.employeeId)
  );

  const annualLeaveType = asRow<LeaveType>(
    db.prepare("SELECT * FROM leave_types WHERE name_en = 'Annual leave'").get()
  );

  const asOf = new Date().toISOString().slice(0, 10);
  const rules = getEntitlementRules();

  const carryOverSetting = db
    .prepare("SELECT * FROM carry_over_settings WHERE scope = 'company' LIMIT 1")
    .get() as { max_days: number } | undefined;

  const pending = getPendingLeaveDays(employee.id, annualLeaveType.id);

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
    annualLeaveType.id,
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

  const recentRequests = db
    .prepare(
      `SELECT 'leave' as kind, lr.id, lt.name_en as type_name, lr.start_date, lr.end_date, lr.working_days as amount, lr.status, lr.created_at
       FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.employee_id = ?
       ORDER BY lr.created_at DESC LIMIT 5`
    )
    .all(employee.id);

  res.render("dashboard", {
    title: t(lang, "nav.dashboard"),
    lang,
    employee,
    balance,
    carryOverSetting,
    recentRequests,
  });
});
