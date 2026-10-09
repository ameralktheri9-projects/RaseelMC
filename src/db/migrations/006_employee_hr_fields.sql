-- Contract tracking (contract_end_date is computed in application code from
-- contract_start_date + the default contract length, and stored so it can be
-- queried/reported on directly without recomputing).
ALTER TABLE employees ADD COLUMN contract_start_date TEXT;
ALTER TABLE employees ADD COLUMN contract_end_date TEXT;

-- Salary breakdown. gross_salary (already existed) is kept as the auto-computed sum of
-- these, since it's what loan eligibility (LN-*) already reads — nothing downstream needs
-- to change to know about the breakdown.
ALTER TABLE employees ADD COLUMN salary_basic DOUBLE PRECISION;
ALTER TABLE employees ADD COLUMN salary_housing DOUBLE PRECISION;
ALTER TABLE employees ADD COLUMN salary_transport DOUBLE PRECISION;
ALTER TABLE employees ADD COLUMN salary_other DOUBLE PRECISION;

-- Per-employee override of the computed annual leave entitlement (normally resolved from
-- leave_entitlement_rules by years of service) — NULL means "use the computed value".
ALTER TABLE employees ADD COLUMN annual_leave_override DOUBLE PRECISION;

ALTER TABLE employees ADD COLUMN nationality TEXT;
ALTER TABLE employees ADD COLUMN cr_type TEXT CHECK (cr_type IN ('main','branch','optics'));
ALTER TABLE employees ADD COLUMN sponsorship_type TEXT CHECK (sponsorship_type IN ('company','other'));

ALTER TABLE employees ADD COLUMN bank_name TEXT;
ALTER TABLE employees ADD COLUMN bank_branch_number TEXT;
ALTER TABLE employees ADD COLUMN bank_iban TEXT;
