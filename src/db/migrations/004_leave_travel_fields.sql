-- Exit/re-entry visa and flight ticket requests are common additions to a leave request for
-- expat staff travelling abroad; HR/the approver needs to see these to arrange them.
ALTER TABLE leave_requests ADD COLUMN wants_exit_reentry INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leave_requests ADD COLUMN wants_flight_ticket INTEGER NOT NULL DEFAULT 0;
