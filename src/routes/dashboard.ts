import { Router } from "express";
import { db, asRow } from "../db";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
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

dashboardRouter.get(
  "/dashboard",
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user!;
    const lang = sessionUser.language;

    if (!sessionUser.employeeId) {
      // System admin / HR-only account with no linked employee record: show company-wide stats instead.
      const totalEmployees = (
        (await db.prepare("SELECT COUNT(*) as n FROM employees WHERE status = 'active'").get()) as {
          n: number;
        }
      ).n;
      const pendingLeaveCount = (
        (await db.prepare("SELECT COUNT(*) as n FROM leave_requests WHERE status = 'pending'").get()) as {
          n: number;
        }
      ).n;
      const pendingLoanCount = (
        (await db.prepare("SELECT COUNT(*) as n FROM loan_requests WHERE status = 'pending'").get()) as {
          n: number;
        }
      ).n;
      const activeLoans = (await db
        .prepare(
          `SELECT COUNT(*) as n, COALESCE(SUM(amount), 0) as total_amount,
                  COALESCE((SELECT SUM(amount) FROM loan_instalments li
                            WHERE li.loan_request_id IN (SELECT id FROM loan_requests WHERE status = 'disbursed')
                            AND li.status = 'deducted'), 0) as total_paid
           FROM loan_requests WHERE status = 'disbursed'`
        )
        .get()) as { n: number; total_amount: number; total_paid: number };
      const today = new Date().toISOString().slice(0, 10);
      const onLeaveToday = await db
        .prepare(
          `SELECT e.name_en, e.name_ar, lr.end_date
           FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
           WHERE lr.status = 'approved' AND lr.start_date <= ? AND lr.end_date >= ?
           ORDER BY lr.end_date`
        )
        .all(today, today);
      const recentActivity = await db
        .prepare(
          `SELECT al.action, al.record_type, al.created_at, u.username
           FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
           ORDER BY al.id DESC LIMIT 8`
        )
        .all();

      res.render("dashboard", {
        title: t(lang, "nav.dashboard"),
        lang,
        employee: null,
        balance: null,
        adminStats: {
          totalEmployees,
          pendingLeaveCount,
          pendingLoanCount,
          activeLoansCount: activeLoans.n,
          activeLoansOutstanding: activeLoans.total_amount - activeLoans.total_paid,
          onLeaveToday,
          recentActivity,
        },
      });
      return;
    }

    const employee = asRow<Employee>(
      await db.prepare("SELECT * FROM employees WHERE id = ?").get(sessionUser.employeeId)
    );

    const annualLeaveType = asRow<LeaveType>(
      await db.prepare("SELECT * FROM leave_types WHERE name_en = 'Annual leave'").get()
    );

    const asOf = new Date().toISOString().slice(0, 10);
    const rules = await getEntitlementRules();

    const carryOverSetting = (await db
      .prepare("SELECT * FROM carry_over_settings WHERE scope = 'company' LIMIT 1")
      .get()) as { max_days: number } | undefined;

    const pending = await getPendingLeaveDays(employee.id, annualLeaveType.id);

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

    const recentRequests = await db
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
  })
);
