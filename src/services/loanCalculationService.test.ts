import { describe, it, expect } from "vitest";
import {
  planFromFixedAmount,
  planFromMonths,
  validateLoanPlan,
  resolveEffectiveLoanLimits,
  type EffectiveLoanLimits,
} from "./loanCalculationService";
import type { LoanRule, LoanRuleOverride } from "../models/types";

describe("BRD 6.2 worked example: loan SAR 6,000", () => {
  it("Option A - fixed SAR 1,000/month -> 6 months", () => {
    const plan = planFromFixedAmount(6000, 1000, "2026-11");
    expect(plan.months).toBe(6);
    expect(plan.schedule).toHaveLength(6);
    expect(plan.schedule.every((s) => s.amount === 1000)).toBe(true);
    expect(plan.schedule.at(-1)!.remainingAfter).toBe(0);
  });

  it("Option B - 4 months -> SAR 1,500/month", () => {
    const plan = planFromMonths(6000, 4, "2026-11");
    expect(plan.monthlyAmount).toBe(1500);
    expect(plan.schedule).toHaveLength(4);
    expect(plan.schedule.at(-1)!.remainingAfter).toBe(0);
  });

  it("capped at SAR 800/month max deduction -> both options blocked, suggests >= 8 months", () => {
    const limits: EffectiveLoanLimits = {
      maxAmount: null,
      maxMonths: null,
      maxMonthlyDeduction: 800,
      maxMonthlyDeductionIsPercent: false,
      maxSimultaneousLoans: null,
      waitingPeriodMonths: null,
      eligibility: "allowed",
    };

    const planA = planFromFixedAmount(6000, 1000, "2026-11");
    const resultA = validateLoanPlan(6000, planA, limits, null, 0);
    expect(resultA.valid).toBe(false);
    expect(resultA.suggestedMinMonths).toBe(8);

    const planB = planFromMonths(6000, 4, "2026-11");
    const resultB = validateLoanPlan(6000, planB, limits, null, 0);
    expect(resultB.valid).toBe(false);
    expect(resultB.suggestedMinMonths).toBe(8);
  });
});

describe("design screenshot example: loan SAR 6,000, SAR 750/month", () => {
  it("resolves to 8 months, Nov 2026 -> Jun 2027", () => {
    const plan = planFromFixedAmount(6000, 750, "2026-11");
    expect(plan.months).toBe(8);
    expect(plan.schedule[0].dueMonth).toBe("2026-11");
    expect(plan.schedule.at(-1)!.dueMonth).toBe("2027-06");
    expect(plan.schedule.every((s) => s.amount === 750)).toBe(true);
  });
});

describe("LR-02 per-employee override resolution", () => {
  const companyDefault: LoanRule = {
    id: 1,
    scope: "company",
    max_amount: null,
    max_months: null,
    max_monthly_deduction: 10,
    max_monthly_deduction_is_percent: 1,
    max_simultaneous_loans: null,
    waiting_period_months: null,
    eligibility: "allowed",
  };

  it("blank override fields inherit the company default", () => {
    const override: LoanRuleOverride = {
      id: 1,
      employee_id: 1,
      max_amount: null,
      max_months: null,
      max_monthly_deduction: 800,
      max_monthly_deduction_is_percent: 0,
      max_simultaneous_loans: null,
      waiting_period_months: null,
      eligibility: null,
      reason: "test",
      updated_by_user_id: null,
      updated_at: "",
    };
    const effective = resolveEffectiveLoanLimits(companyDefault, override);
    expect(effective.maxMonthlyDeduction).toBe(800);
    expect(effective.maxMonthlyDeductionIsPercent).toBe(false);
    expect(effective.eligibility).toBe("allowed"); // inherited, override left blank
  });

  it("no override at all falls back entirely to company defaults", () => {
    const effective = resolveEffectiveLoanLimits(companyDefault, null);
    expect(effective.maxMonthlyDeduction).toBe(10);
    expect(effective.maxMonthlyDeductionIsPercent).toBe(true);
  });
});
