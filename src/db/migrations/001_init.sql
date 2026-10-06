-- Raseel MC — initial schema
-- Postgres (Neon). Dates stored as ISO-8601 text (YYYY-MM-DD) or datetime text; money as
-- DOUBLE PRECISION (SAR, 2dp by convention, matching the app's existing JS rounding);
-- booleans as INTEGER 0/1 (kept as INTEGER, not native BOOLEAN, to match existing app code
-- that reads/writes these columns as 0/1 throughout).

CREATE TABLE departments (
  id SERIAL PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  head_employee_id INTEGER -- FK to employees(id) added below, once that table exists
);

CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  employee_code TEXT NOT NULL UNIQUE, -- e.g. RMC-1042
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  national_id TEXT, -- national ID / Iqama no.
  department_id INTEGER REFERENCES departments(id),
  job_title TEXT,
  job_grade TEXT,
  direct_manager_id INTEGER REFERENCES employees(id),
  joining_date TEXT NOT NULL, -- YYYY-MM-DD
  gross_salary DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_leave','terminated')),
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

ALTER TABLE departments ADD CONSTRAINT fk_departments_head_employee
  FOREIGN KEY (head_employee_id) REFERENCES employees(id);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER UNIQUE REFERENCES employees(id),
  username TEXT NOT NULL UNIQUE, -- employee ID or work email
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  password_changed_at TEXT,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','ar')),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT, -- datetime text; NULL = not locked
  last_login_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

-- Identity roles: every user has 'employee' implicitly; explicit rows grant extra roles.
CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('hr_officer','finance','system_admin')),
  PRIMARY KEY (user_id, role)
);

-- Maps a singular org role (used by workflow "Role" approver steps) to one employee at a time.
CREATE TABLE org_role_assignments (
  org_role TEXT PRIMARY KEY CHECK (org_role IN ('hr_manager','finance_manager','ceo','medical_director')),
  employee_id INTEGER NOT NULL REFERENCES employees(id)
);

CREATE TABLE leave_types (
  id SERIAL PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  is_paid INTEGER NOT NULL DEFAULT 1,
  annual_days DOUBLE PRECISION, -- NULL for types that use the service-year entitlement table (annual leave)
  accrual_method TEXT NOT NULL DEFAULT 'monthly' CHECK (accrual_method IN ('monthly','upfront')),
  requires_attachment INTEGER NOT NULL DEFAULT 0,
  allows_negative_balance INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Entitlement bands for the "annual leave" type, keyed by years of service. Configurable (LV-02).
CREATE TABLE leave_entitlement_rules (
  id SERIAL PRIMARY KEY,
  min_years_service DOUBLE PRECISION NOT NULL, -- e.g. 0, 5
  annual_days DOUBLE PRECISION NOT NULL        -- e.g. 21, 30
);

CREATE TABLE holidays (
  id SERIAL PRIMARY KEY,
  holiday_date TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL
);

CREATE TABLE leave_balances (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  leave_year_start TEXT NOT NULL, -- anniversary-based year start
  leave_year_end TEXT NOT NULL,
  entitlement DOUBLE PRECISION NOT NULL DEFAULT 0,     -- full-year entitlement
  carried_over DOUBLE PRECISION NOT NULL DEFAULT 0,
  carry_over_expires_on TEXT,
  taken DOUBLE PRECISION NOT NULL DEFAULT 0,
  manual_adjustment DOUBLE PRECISION NOT NULL DEFAULT 0,
  UNIQUE (employee_id, leave_type_id, leave_year_start)
);

CREATE TABLE carry_over_settings (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'company' CHECK (scope IN ('company','department','job_grade')),
  scope_value TEXT, -- department id or job grade name; NULL for company-wide
  method TEXT NOT NULL CHECK (method IN ('days','percentage','none')),
  max_days DOUBLE PRECISION,
  percentage DOUBLE PRECISION,
  percentage_cap_days DOUBLE PRECISION,
  expiry_months INTEGER, -- NULL = no expiry
  rounding TEXT NOT NULL DEFAULT 'nearest_half' CHECK (rounding IN ('nearest_half','down','up'))
);

CREATE TABLE loan_rules (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'company' CHECK (scope IN ('company')),
  max_amount DOUBLE PRECISION,              -- NULL = no limit
  max_months INTEGER,           -- NULL = no limit
  max_monthly_deduction DOUBLE PRECISION,
  max_monthly_deduction_is_percent INTEGER NOT NULL DEFAULT 0,
  max_simultaneous_loans INTEGER,
  waiting_period_months INTEGER,
  eligibility TEXT NOT NULL DEFAULT 'allowed' CHECK (eligibility IN ('allowed','not_allowed'))
);

CREATE TABLE loan_rule_overrides (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL UNIQUE REFERENCES employees(id),
  max_amount DOUBLE PRECISION,
  max_months INTEGER,
  max_monthly_deduction DOUBLE PRECISION,
  max_monthly_deduction_is_percent INTEGER NOT NULL DEFAULT 0,
  max_simultaneous_loans INTEGER,
  waiting_period_months INTEGER,
  eligibility TEXT CHECK (eligibility IN ('allowed','not_allowed')),
  reason TEXT,
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE workflows (
  id SERIAL PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  request_type TEXT NOT NULL CHECK (request_type IN ('leave','loan')),
  version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0, -- fallback workflow for this request_type
  conditions_json TEXT NOT NULL DEFAULT '{}', -- {leaveTypeId, departmentId, jobGrade, minDays, maxDays, minAmount, maxAmount}
  sla_escalate_to_employee_id INTEGER REFERENCES employees(id),
  notify_only_user_ids_json TEXT NOT NULL DEFAULT '[]',
  skip_duplicate_approver INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE workflow_steps (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  step_order INTEGER NOT NULL,
  approver_type TEXT NOT NULL CHECK (approver_type IN ('direct_manager','department_head','org_role','specific_user')),
  approver_org_role TEXT, -- when approver_type = org_role
  approver_user_id INTEGER REFERENCES users(id), -- when approver_type = specific_user
  sla_days INTEGER NOT NULL DEFAULT 2,
  is_final INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workflow_id, step_order)
);

CREATE TABLE delegations (
  id SERIAL PRIMARY KEY,
  approver_user_id INTEGER NOT NULL REFERENCES users(id),
  delegate_user_id INTEGER NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);

CREATE TABLE leave_requests (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  working_days DOUBLE PRECISION NOT NULL,
  reason TEXT,
  handover_employee_id INTEGER REFERENCES employees(id),
  attachment_path TEXT,
  attachment_data BYTEA,
  attachment_mimetype TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('draft','pending','returned','approved','rejected','cancelled')
  ),
  current_step_order INTEGER NOT NULL DEFAULT 1,
  workflow_id INTEGER REFERENCES workflows(id),
  workflow_version INTEGER,
  is_cancellation_of INTEGER REFERENCES leave_requests(id), -- set when this is a cancellation request for an approved leave
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE loan_requests (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  amount DOUBLE PRECISION NOT NULL,
  reason TEXT,
  repayment_option TEXT NOT NULL CHECK (repayment_option IN ('fixed_amount','months')),
  monthly_amount DOUBLE PRECISION NOT NULL,
  months INTEGER NOT NULL,
  first_deduction_month TEXT NOT NULL, -- YYYY-MM
  terms_accepted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('draft','pending','returned','approved','rejected','cancelled','disbursed','closed')
  ),
  current_step_order INTEGER NOT NULL DEFAULT 1,
  workflow_id INTEGER REFERENCES workflows(id),
  workflow_version INTEGER,
  disbursed_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE loan_instalments (
  id SERIAL PRIMARY KEY,
  loan_request_id INTEGER NOT NULL REFERENCES loan_requests(id),
  instalment_number INTEGER NOT NULL,
  due_month TEXT NOT NULL, -- YYYY-MM
  amount DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','deducted','skipped')),
  deducted_at TEXT,
  payroll_reference TEXT,
  UNIQUE (loan_request_id, instalment_number)
);

CREATE TABLE approval_actions (
  id SERIAL PRIMARY KEY,
  request_type TEXT NOT NULL CHECK (request_type IN ('leave','loan')),
  request_id INTEGER NOT NULL,
  step_order INTEGER NOT NULL,
  approver_user_id INTEGER REFERENCES users(id),
  acted_as_delegate_for_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('submitted','approved','rejected','returned','cancelled','skipped')),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  message_en TEXT NOT NULL,
  message_ar TEXT NOT NULL,
  link_url TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id INTEGER,
  old_value_json TEXT,
  new_value_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX idx_employees_department ON employees(department_id);
CREATE INDEX idx_employees_manager ON employees(direct_manager_id);
CREATE INDEX idx_leave_requests_employee ON leave_requests(employee_id);
CREATE INDEX idx_leave_requests_status ON leave_requests(status);
CREATE INDEX idx_loan_requests_employee ON loan_requests(employee_id);
CREATE INDEX idx_loan_requests_status ON loan_requests(status);
CREATE INDEX idx_loan_instalments_loan ON loan_instalments(loan_request_id);
CREATE INDEX idx_approval_actions_request ON approval_actions(request_type, request_id);
CREATE INDEX idx_audit_log_record ON audit_log(record_type, record_id);
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);
