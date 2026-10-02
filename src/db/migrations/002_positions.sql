-- Standardized position/job-title list, managed in Settings and used as a
-- dropdown when creating/editing employees (also reusable for job-grade-based
-- exceptions in loan rules / workflow conditions later).

CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

INSERT INTO positions (name_en, name_ar) VALUES
  ('Lab Technician', 'فني مختبر'),
  ('Laboratory Head', 'رئيس المختبر'),
  ('HR Manager', 'مدير الموارد البشرية'),
  ('Finance Manager', 'مدير مالي'),
  ('Chief Executive Officer', 'الرئيس التنفيذي'),
  ('Nurse', 'ممرض/ة'),
  ('Physician', 'طبيب/ة'),
  ('Receptionist', 'موظف استقبال'),
  ('Administrative Assistant', 'مساعد إداري');
