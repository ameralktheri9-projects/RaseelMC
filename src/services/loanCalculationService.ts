import dayjs from "dayjs";
import type { LoanRule, LoanRuleOverride } from "../models/types";

export interface RepaymentScheduleEntry {
  instalmentNumber: number;
  dueMonth: string; // YYYY-MM
  amount: number;
  remainingAfter: number;
}

export interface LoanPlan {
  monthlyAmount: number;
  months: number;
  schedule: RepaymentScheduleEntry[];
}

/**
 * LN-03: Option A (fixed monthly amount) -> months = ceil(amount / monthlyAmount),
 * last instalment carries the remainder.
 */
export function planFromFixedAmount(amount: number, monthlyAmount: number, firstMonth: string): LoanPlan {
  if (monthlyAmount <= 0) throw new Error("Monthly amount must be greater than zero.");
  const months = Math.ceil(amount / monthlyAmount);
  return buildSchedule(amount, monthlyAmount, months, firstMonth);
}

/**
 * LN-04: Option B (number of months) -> monthlyAmount = round(amount / months, 2),
 * last instalment adjusts for rounding.
 */
export function planFromMonths(amount: number, months: number, firstMonth: string): LoanPlan {
  if (months <= 0) throw new Error("Months must be greater than zero.");
  const monthlyAmount = roundMoney(amount / months);
  return buildSchedule(amount, monthlyAmount, months, firstMonth);
}

function buildSchedule(
  amount: number,
  monthlyAmount: number,
  months: number,
  firstMonth: string
): LoanPlan {
  const schedule: RepaymentScheduleEntry[] = [];
  let remaining = roundMoney(amount);
  let cursor = dayjs(`${firstMonth}-01`);

  for (let i = 1; i <= months; i++) {
    const isLast = i === months;
    const instalment = isLast ? remaining : Math.min(monthlyAmount, remaining);
    remaining = roundMoney(remaining - instalment);
    schedule.push({
      instalmentNumber: i,
      dueMonth: cursor.format("YYYY-MM"),
      amount: roundMoney(instalment),
      remainingAfter: Math.max(0, remaining),
    });
    cursor = cursor.add(1, "month");
  }

  return { monthlyAmount, months, schedule };
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface EffectiveLoanLimits {
  maxAmount: number | null;
  maxMonths: number | null;
  maxMonthlyDeduction: number | null;
  maxMonthlyDeductionIsPercent: boolean;
  maxSimultaneousLoans: number | null;
  waitingPeriodMonths: number | null;
  eligibility: "allowed" | "not_allowed";
}

/** LR-02: per-employee override replaces the company default field-by-field (blank = inherit default). */
export function resolveEffectiveLoanLimits(
  companyDefault: LoanRule,
  override: LoanRuleOverride | null
): EffectiveLoanLimits {
  return {
    maxAmount: override?.max_amount ?? companyDefault.max_amount,
    maxMonths: override?.max_months ?? companyDefault.max_months,
    maxMonthlyDeduction: override?.max_monthly_deduction ?? companyDefault.max_monthly_deduction,
    maxMonthlyDeductionIsPercent:
      (override?.max_monthly_deduction_is_percent ?? companyDefault.max_monthly_deduction_is_percent) === 1,
    maxSimultaneousLoans: override?.max_simultaneous_loans ?? companyDefault.max_simultaneous_loans,
    waitingPeriodMonths: override?.waiting_period_months ?? companyDefault.waiting_period_months,
    eligibility: (override?.eligibility ?? companyDefault.eligibility) as "allowed" | "not_allowed",
  };
}

export interface LoanValidationResult {
  valid: boolean;
  errors: string[];
  suggestedMinMonths?: number;
}

/** LR-04: validate a requested plan against the employee's effective limits. */
export function validateLoanPlan(
  amount: number,
  plan: LoanPlan,
  limits: EffectiveLoanLimits,
  grossSalary: number | null,
  activeLoanCount: number
): LoanValidationResult {
  const errors: string[] = [];

  if (limits.eligibility === "not_allowed") {
    errors.push("This employee is not eligible to request a loan.");
  }
  if (limits.maxAmount != null && amount > limits.maxAmount) {
    errors.push(`Amount exceeds the maximum loan amount of SAR ${limits.maxAmount}.`);
  }
  if (limits.maxMonths != null && plan.months > limits.maxMonths) {
    errors.push(`Repayment period exceeds the maximum of ${limits.maxMonths} months.`);
  }
  if (limits.maxSimultaneousLoans != null && activeLoanCount >= limits.maxSimultaneousLoans) {
    errors.push(`Maximum simultaneous active loans (${limits.maxSimultaneousLoans}) already reached.`);
  }

  let maxMonthlyDeductionAmount: number | null = null;
  if (limits.maxMonthlyDeduction != null) {
    maxMonthlyDeductionAmount = limits.maxMonthlyDeductionIsPercent
      ? roundMoney(((grossSalary ?? 0) * limits.maxMonthlyDeduction) / 100)
      : limits.maxMonthlyDeduction;

    if (plan.monthlyAmount > maxMonthlyDeductionAmount) {
      const suggestedMinMonths = Math.ceil(amount / maxMonthlyDeductionAmount);
      errors.push(
        `Monthly deduction of SAR ${plan.monthlyAmount} exceeds the maximum of SAR ${maxMonthlyDeductionAmount}.`
      );
      return { valid: false, errors, suggestedMinMonths };
    }
  }

  return { valid: errors.length === 0, errors };
}
