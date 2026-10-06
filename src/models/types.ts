export type Language = "en" | "ar";

export type UserRole = "hr_officer" | "finance" | "system_admin";

export type OrgRole = "hr_manager" | "finance_manager" | "ceo" | "medical_director";

export type RequestType = "leave" | "loan";

export type LeaveRequestStatus =
  | "draft"
  | "pending"
  | "returned"
  | "approved"
  | "rejected"
  | "cancelled";

export type LoanRequestStatus =
  | "draft"
  | "pending"
  | "returned"
  | "approved"
  | "rejected"
  | "cancelled"
  | "disbursed"
  | "closed";

export type ApproverType = "direct_manager" | "department_head" | "org_role" | "specific_user";

export type ApprovalActionType =
  | "submitted"
  | "approved"
  | "rejected"
  | "returned"
  | "cancelled"
  | "skipped";

export interface Employee {
  id: number;
  employee_code: string;
  name_en: string;
  name_ar: string;
  national_id: string | null;
  department_id: number | null;
  job_title: string | null;
  job_grade: string | null;
  direct_manager_id: number | null;
  joining_date: string; // YYYY-MM-DD
  gross_salary: number | null;
  status: "active" | "on_leave" | "terminated";
  created_at: string;
  updated_at: string;
}

export interface User {
  id: number;
  employee_id: number | null;
  username: string;
  password_hash: string;
  must_change_password: number; // 0/1
  password_changed_at: string | null;
  language: Language;
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  is_active: number;
  created_at: string;
}

export interface Department {
  id: number;
  name_en: string;
  name_ar: string;
  head_employee_id: number | null;
}

export interface LeaveType {
  id: number;
  name_en: string;
  name_ar: string;
  is_paid: number;
  annual_days: number | null;
  accrual_method: "monthly" | "upfront";
  requires_attachment: number;
  allows_negative_balance: number;
  is_active: number;
}

export interface LeaveEntitlementRule {
  id: number;
  min_years_service: number;
  annual_days: number;
}

export interface Holiday {
  id: number;
  holiday_date: string;
  name_en: string;
  name_ar: string;
}

export interface LeaveBalance {
  id: number;
  employee_id: number;
  leave_type_id: number;
  leave_year_start: string;
  leave_year_end: string;
  entitlement: number;
  carried_over: number;
  carry_over_expires_on: string | null;
  taken: number;
  manual_adjustment: number;
}

export interface CarryOverSetting {
  id: number;
  scope: "company" | "department" | "job_grade";
  scope_value: string | null;
  method: "days" | "percentage" | "none";
  max_days: number | null;
  percentage: number | null;
  percentage_cap_days: number | null;
  expiry_months: number | null;
  rounding: "nearest_half" | "down" | "up";
}

export interface LoanRule {
  id: number;
  scope: "company";
  max_amount: number | null;
  max_months: number | null;
  max_monthly_deduction: number | null;
  max_monthly_deduction_is_percent: number;
  max_simultaneous_loans: number | null;
  waiting_period_months: number | null;
  eligibility: "allowed" | "not_allowed";
}

export interface LoanRuleOverride {
  id: number;
  employee_id: number;
  max_amount: number | null;
  max_months: number | null;
  max_monthly_deduction: number | null;
  max_monthly_deduction_is_percent: number;
  max_simultaneous_loans: number | null;
  waiting_period_months: number | null;
  eligibility: "allowed" | "not_allowed" | null;
  reason: string | null;
  updated_by_user_id: number | null;
  updated_at: string;
}

export interface Workflow {
  id: number;
  name_en: string;
  name_ar: string;
  request_type: RequestType;
  version: number;
  is_active: number;
  is_default: number;
  conditions_json: string;
  sla_escalate_to_employee_id: number | null;
  notify_only_user_ids_json: string;
  skip_duplicate_approver: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowConditions {
  leaveTypeId?: number;
  departmentId?: number;
  jobGrade?: string;
  minDays?: number;
  maxDays?: number;
  minAmount?: number;
  maxAmount?: number;
}

export interface WorkflowStep {
  id: number;
  workflow_id: number;
  step_order: number;
  approver_type: ApproverType;
  approver_org_role: OrgRole | null;
  approver_user_id: number | null;
  sla_days: number;
  is_final: number;
}

export interface Delegation {
  id: number;
  approver_user_id: number;
  delegate_user_id: number;
  start_date: string;
  end_date: string;
}

export interface LeaveRequest {
  id: number;
  employee_id: number;
  leave_type_id: number;
  start_date: string;
  end_date: string;
  working_days: number;
  reason: string | null;
  handover_employee_id: number | null;
  attachment_path: string | null;
  attachment_data: Buffer | null;
  attachment_mimetype: string | null;
  status: LeaveRequestStatus;
  current_step_order: number;
  workflow_id: number | null;
  workflow_version: number | null;
  is_cancellation_of: number | null;
  created_at: string;
  updated_at: string;
}

export interface LoanRequest {
  id: number;
  employee_id: number;
  amount: number;
  reason: string | null;
  repayment_option: "fixed_amount" | "months";
  monthly_amount: number;
  months: number;
  first_deduction_month: string; // YYYY-MM
  terms_accepted: number;
  status: LoanRequestStatus;
  current_step_order: number;
  workflow_id: number | null;
  workflow_version: number | null;
  disbursed_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoanInstalment {
  id: number;
  loan_request_id: number;
  instalment_number: number;
  due_month: string;
  amount: number;
  status: "scheduled" | "deducted" | "skipped";
  deducted_at: string | null;
  payroll_reference: string | null;
}

export interface ApprovalAction {
  id: number;
  request_type: RequestType;
  request_id: number;
  step_order: number;
  approver_user_id: number | null;
  acted_as_delegate_for_user_id: number | null;
  action: ApprovalActionType;
  comment: string | null;
  created_at: string;
}

export interface NotificationRow {
  id: number;
  user_id: number;
  event_type: string;
  message_en: string;
  message_ar: string;
  link_url: string | null;
  is_read: number;
  created_at: string;
}

export interface AuditLogRow {
  id: number;
  user_id: number | null;
  action: string;
  record_type: string;
  record_id: number | null;
  old_value_json: string | null;
  new_value_json: string | null;
  ip_address: string | null;
  created_at: string;
}

// Session-attached user context
export interface SessionUser {
  userId: number;
  employeeId: number | null;
  username: string;
  nameEn: string;
  nameAr: string;
  roles: UserRole[];
  language: Language;
  mustChangePassword: boolean;
}
