import { describe, it, expect } from "vitest";
import {
  resolveAnnualEntitlement,
  leaveYearWindow,
  computeLeaveBalance,
  computeCarryOver,
  workingDaysBetween,
} from "./leaveCalculationService";
import type { Employee, LeaveEntitlementRule, Holiday, CarryOverSetting } from "../models/types";

const entitlementRules: LeaveEntitlementRule[] = [
  { id: 1, min_years_service: 0, annual_days: 21 },
  { id: 2, min_years_service: 5, annual_days: 30 },
];

function makeEmployee(joining_date: string): Employee {
  return {
    id: 1,
    employee_code: "TEST-1",
    name_en: "Test",
    name_ar: "اختبار",
    national_id: null,
    department_id: null,
    job_title: null,
    job_grade: null,
    direct_manager_id: null,
    joining_date,
    gross_salary: null,
    personal_email: null,
    phone: null,
    date_of_birth: null,
    contract_start_date: null,
    contract_end_date: null,
    salary_basic: null,
    salary_housing: null,
    salary_transport: null,
    salary_other: null,
    annual_leave_override: null,
    nationality: null,
    cr_type: null,
    sponsorship_type: null,
    bank_name: null,
    bank_branch_number: null,
    bank_iban: null,
    status: "active",
    created_at: "",
    updated_at: "",
  };
}

describe("BRD 6.1 worked example", () => {
  it("joined 15-Mar-2024, as of 02-Oct-2026: 21-day entitlement, 10.5 accrued, 5.5 remaining with carry 4 / taken 7 / pending 2", () => {
    const employee = makeEmployee("2024-03-15");
    const asOf = "2026-10-02";

    const years =
      (new Date(asOf).getTime() - new Date(employee.joining_date).getTime()) /
      (365.25 * 24 * 3600 * 1000);
    expect(resolveAnnualEntitlement(years, entitlementRules)).toBe(21);

    const window = leaveYearWindow(employee.joining_date, asOf);
    expect(window.start).toBe("2026-03-15");

    const balance = computeLeaveBalance({
      employee,
      asOf,
      entitlementRules,
      carriedOver: 4,
      taken: 7,
      pending: 2,
      manualAdjustment: 0,
    });

    expect(balance.fullYearEntitlement).toBe(21);
    expect(balance.accruedToDate).toBe(10.5);
    expect(balance.remaining).toBe(5.5);
  });
});

describe("BRD 6.1 entitlement bands", () => {
  it("30 days/year from the 6th year of service", () => {
    expect(resolveAnnualEntitlement(5, entitlementRules)).toBe(30);
    expect(resolveAnnualEntitlement(4.9, entitlementRules)).toBe(21);
  });
});

describe("BRD 6.1 carry-over examples (unused balance = 14 days)", () => {
  it("Number of days, max 10 -> 10 carried, 4 lapsed", () => {
    const setting: CarryOverSetting = {
      id: 1,
      scope: "company",
      scope_value: null,
      method: "days",
      max_days: 10,
      percentage: null,
      percentage_cap_days: null,
      expiry_months: null,
      rounding: "nearest_half",
    };
    expect(computeCarryOver(14, setting)).toEqual({ carried: 10, lapsed: 4 });
  });

  it("Percentage 50%, no cap -> 7 carried, 7 lapsed", () => {
    const setting: CarryOverSetting = {
      id: 1,
      scope: "company",
      scope_value: null,
      method: "percentage",
      max_days: null,
      percentage: 50,
      percentage_cap_days: null,
      expiry_months: null,
      rounding: "nearest_half",
    };
    expect(computeCarryOver(14, setting)).toEqual({ carried: 7, lapsed: 7 });
  });

  it("Percentage 75%, cap 8 days -> 8 carried (10.5 capped), 6 lapsed", () => {
    const setting: CarryOverSetting = {
      id: 1,
      scope: "company",
      scope_value: null,
      method: "percentage",
      max_days: null,
      percentage: 75,
      percentage_cap_days: 8,
      expiry_months: null,
      rounding: "nearest_half",
    };
    expect(computeCarryOver(14, setting)).toEqual({ carried: 8, lapsed: 6 });
  });

  it("No carry-over -> 0 carried, 14 lapsed", () => {
    const setting: CarryOverSetting = {
      id: 1,
      scope: "company",
      scope_value: null,
      method: "none",
      max_days: null,
      percentage: null,
      percentage_cap_days: null,
      expiry_months: null,
      rounding: "nearest_half",
    };
    expect(computeCarryOver(14, setting)).toEqual({ carried: 0, lapsed: 14 });
  });
});

describe("LV-10 working-day calculation", () => {
  it("excludes Friday/Saturday weekends", () => {
    // 2026-11-05 Thu, 06 Fri, 07 Sat, 08 Sun, 09 Mon -> 3 working days (Thu, Sun, Mon)
    const holidays: Holiday[] = [];
    expect(workingDaysBetween("2026-11-05", "2026-11-09", holidays)).toBe(3);
  });

  it("excludes official holidays too", () => {
    const holidays: Holiday[] = [
      { id: 1, holiday_date: "2026-09-23", name_en: "Saudi National Day", name_ar: "" },
    ];
    // 2026-09-22 Tue to 2026-09-24 Thu, with the 23rd a holiday -> 2 working days
    expect(workingDaysBetween("2026-09-22", "2026-09-24", holidays)).toBe(2);
  });
});
