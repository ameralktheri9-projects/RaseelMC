-- Self-service contact fields employees can edit themselves on their profile page
-- (everything else on `employees` is HR-managed via Settings, not self-editable).
ALTER TABLE employees ADD COLUMN personal_email TEXT;
ALTER TABLE employees ADD COLUMN phone TEXT;
