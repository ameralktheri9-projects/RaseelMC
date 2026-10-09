import dayjs from "dayjs";
import { db, asRow } from "../db";
import type { Employee, Holiday, LeaveEntitlementRule, LeaveBalance, CarryOverSetting } from "../models/types";

/** Years of service as a decimal, from joining date to asOf date. */
export function yearsOfService(joiningDate: string, asOf: string): number {
  const start = dayjs(joiningDate);
  const end = dayjs(asOf);
  const totalMonths = end.diff(start, "month");
  return totalMonths / 12;
}

/** Full months of service completed since the most recent leave-year anniversary. */
export function completedMonthsSince(anniversaryStart: string, asOf: string): number {
  const months = dayjs(asOf).diff(dayjs(anniversaryStart), "month");
  return Math.max(0, Math.min(12, months));
}

/** The leave-year window (anniversary-based) containing asOf. */
export function leaveYearWindow(
  joiningDate: string,
  asOf: string
): { start: string; end: string } {
  const join = dayjs(joiningDate);
  const asOfDate = dayjs(asOf);
  let yearsElapsed = asOfDate.diff(join, "year");
  let start = join.add(yearsElapsed, "year");
  if (start.isAfter(asOfDate)) {
    yearsElapsed -= 1;
    start = join.add(yearsElapsed, "year");
  }
  const end = start.add(1, "year").subtract(1, "day");
  return { start: start.format("YYYY-MM-DD"), end: end.format("YYYY-MM-DD") };
}

/** Resolve the annual entitlement (days/year) for a given service length, from configured bands. */
export function resolveAnnualEntitlement(
  years: number,
  rules: LeaveEntitlementRule[]
): number {
  const sorted = [...rules].sort((a, b) => b.min_years_service - a.min_years_service);
  const match = sorted.find((r) => years >= r.min_years_service);
  return match ? match.annual_days : sorted[sorted.length - 1]?.annual_days ?? 0;
}

export interface LeaveBalanceSummary {
  fullYearEntitlement: number;
  accruedToDate: number;
  carriedOver: number;
  taken: number;
  pending: number;
  remaining: number;
  leaveYearStart: string;
  leaveYearEnd: string;
}

/**
 * LV-01..LV-05: entitlement, monthly accrual, carry-over, taken/pending, remaining.
 * Remaining = accrued + carriedOver - taken - pending.
 */
export function computeLeaveBalance(params: {
  employee: Employee;
  asOf: string;
  entitlementRules: LeaveEntitlementRule[];
  carriedOver: number;
  taken: number;
  pending: number;
  manualAdjustment: number;
}): LeaveBalanceSummary {
  const { employee, asOf, entitlementRules, carriedOver, taken, pending, manualAdjustment } = params;
  const years = yearsOfService(employee.joining_date, asOf);
  // A per-employee override (set in Settings > Users) always wins over the computed band.
  const fullYearEntitlement = employee.annual_leave_override ?? resolveAnnualEntitlement(years, entitlementRules);
  const { start, end } = leaveYearWindow(employee.joining_date, asOf);
  const completedMonths = completedMonthsSince(start, asOf);
  const accruedToDate = roundToHalf((fullYearEntitlement / 12) * completedMonths);
  const remaining = accruedToDate + carriedOver + manualAdjustment - taken - pending;

  return {
    fullYearEntitlement,
    accruedToDate,
    carriedOver,
    taken,
    pending,
    remaining,
    leaveYearStart: start,
    leaveYearEnd: end,
  };
}

function roundToHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

/** LV-10: working days between two dates (inclusive), excluding Fri/Sat and holidays. */
export function workingDaysBetween(startDate: string, endDate: string, holidays: Holiday[]): number {
  const holidaySet = new Set(holidays.map((h) => h.holiday_date));
  let count = 0;
  let cursor = dayjs(startDate);
  const end = dayjs(endDate);
  while (cursor.isBefore(end) || cursor.isSame(end, "day")) {
    const dow = cursor.day(); // 0=Sun..6=Sat
    const isWeekend = dow === 5 || dow === 6; // Friday=5, Saturday=6
    const iso = cursor.format("YYYY-MM-DD");
    if (!isWeekend && !holidaySet.has(iso)) count++;
    cursor = cursor.add(1, "day");
  }
  return count;
}

/** CO-01..CO-03: compute carry-over for one employee from unused balance at year-end. */
export function computeCarryOver(
  unusedBalance: number,
  setting: CarryOverSetting
): { carried: number; lapsed: number } {
  if (setting.method === "none" || unusedBalance <= 0) {
    return { carried: 0, lapsed: Math.max(0, unusedBalance) };
  }
  let carried: number;
  if (setting.method === "days") {
    carried = Math.min(unusedBalance, setting.max_days ?? 0);
  } else {
    const pct = (setting.percentage ?? 0) / 100;
    carried = roundToHalf(unusedBalance * pct);
    if (setting.percentage_cap_days != null) {
      carried = Math.min(carried, setting.percentage_cap_days);
    }
  }
  carried = Math.min(carried, unusedBalance);
  const lapsed = Math.max(0, unusedBalance - carried);
  return { carried, lapsed };
}

export async function getHolidays(): Promise<Holiday[]> {
  return asRow<Holiday[]>(await db.prepare("SELECT * FROM holidays ORDER BY holiday_date").all());
}

export async function getEntitlementRules(): Promise<LeaveEntitlementRule[]> {
  return asRow<LeaveEntitlementRule[]>(
    await db.prepare("SELECT * FROM leave_entitlement_rules ORDER BY min_years_service").all()
  );
}

export async function getOrCreateLeaveBalanceRow(
  employeeId: number,
  leaveTypeId: number,
  leaveYearStart: string,
  leaveYearEnd: string,
  entitlement: number
): Promise<LeaveBalance> {
  const existing = await db
    .prepare(
      "SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND leave_year_start = ?"
    )
    .get(employeeId, leaveTypeId, leaveYearStart);
  const existingRow = asRow<LeaveBalance | undefined>(existing);
  if (existingRow) return existingRow;

  await db.prepare(
    `INSERT INTO leave_balances
      (employee_id, leave_type_id, leave_year_start, leave_year_end, entitlement, carried_over, taken, manual_adjustment)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0)`
  ).run(employeeId, leaveTypeId, leaveYearStart, leaveYearEnd, entitlement);

  return asRow<LeaveBalance>(
    await db
      .prepare(
        "SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND leave_year_start = ?"
      )
      .get(employeeId, leaveTypeId, leaveYearStart)
  );
}

export async function getPendingLeaveDays(employeeId: number, leaveTypeId: number): Promise<number> {
  const row = (await db
    .prepare(
      `SELECT COALESCE(SUM(working_days), 0) as total FROM leave_requests
       WHERE employee_id = ? AND leave_type_id = ? AND status = 'pending'`
    )
    .get(employeeId, leaveTypeId)) as { total: number };
  return row.total;
}
