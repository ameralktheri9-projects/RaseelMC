-- Replaces the previously-hardcoded 2-year contract assumption with a per-employee value HR sets.
ALTER TABLE employees ADD COLUMN contract_period_months INTEGER;
