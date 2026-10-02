# Raseel MC — Leave & Loan Management Platform

Internal, on-premise web app for Raseel Medical Center: employees see their
leave balance, request leave, request salary-deducted loans, and every
request routes through an admin-configurable approval workflow. Built from
`Raseel-MC-BRD.pdf` and `Raseel-MC-Screen-Designs.pdf`.

## Tech stack

Node.js + TypeScript + Express, server-rendered EJS views, SQLite via Node's
built-in `node:sqlite` (no native dependencies, no separate database server
to install). Bilingual English/Arabic with RTL layout. Bootstrap is
self-hosted (not loaded from a CDN) since this app is meant to run on a
network with no internet access.

See `.claude/plans/` conversation history for why this stack was chosen over
the BRD's suggested ASP.NET Core + SQL Server (short version: this dev
environment's network couldn't sustain large installer downloads; Node was
already present and SQLite needs zero install).

## Running it

Prerequisites: Node.js 22.5+ (the app uses `node:sqlite`, available from
Node 22.5 onward; developed and tested on Node 24).

```bash
npm install
npm run seed     # creates data/raseel-mc.db, applies the schema, seeds test data
npm run dev      # starts the dev server with auto-reload at http://localhost:3000
```

For a production-style run (no file-watching):

```bash
npm run build
npm start
```

### Test accounts

All seeded besides `admin` use the temporary password `Welcome123` and are
forced to change it on first login (AUTH-03).

| Username  | Role                              | Who               |
|-----------|-----------------------------------|--------------------|
| `admin`   | System Admin (password `Admin123!`, no forced change) | — |
| `RMC-0001`| CEO                               | Dr. Abdullah Al-Rashid |
| `RMC-0002`| HR Officer / HR Manager (org role)| Sara Al-Dosari     |
| `RMC-0003`| Finance / Finance Manager (org role)| Majed Al-Zahrani |
| `RMC-1000`| Approver (Laboratory Head)        | Khalid Al-Otaibi   |
| `RMC-1042`| Employee (Lab Technician)         | Faisal Al-Qahtani  |
| `RMC-1043`| Employee (Lab Technician)         | Huda Al-Mutairi    |

## Moving to another device

Since everything is one SQLite file, moving hosts is just:

1. Copy the whole project folder (or `git clone` the repo) to the new machine.
2. Copy `data/raseel-mc.db` across too if you want to keep existing data —
   otherwise `npm run seed` creates a fresh one.
3. `npm install && npm run build && npm start`.

No database server, no separate install step, on either machine.

## Backups (NF-05)

`scripts/backup-db.ps1` copies the database file with a timestamp into
`data/backups/` and prunes backups older than 30 days. Schedule it nightly
via Windows Task Scheduler (see the comment at the top of the script for the
exact setup) — there's nothing else to back up since the app has no other
persistent state.

## What's built (BRD Phase 1)

Everything marked **M** (Must have) in the BRD's functional requirement
tables, plus several **S** (Should have) items:

- Auth: admin-created accounts, forced password change, lockout, session
  timeout, EN/AR toggle (AUTH-01..07, 09)
- Leave: balance calculation from joining date, accrual, carry-over, request
  form with live balance-impact preview, history, cancellation incl.
  cancelling an already-approved leave (LV-01..16)
- Loans: both repayment options with a live schedule preview, validation
  against company/per-employee limits, Finance disbursement and instalment
  tracking, **early settlement (LN-13)**
- Approval workflow engine: admin-configurable workflows and steps, most-
  specific-match routing, skip-duplicate-approver rule, **delegation
  (AP-04/WF-09)**, full approval trail (WF-01..12)
- Approvals inbox: pending/decided lists, approve/reject/return (AP-01..03)
- Settings: workflow builder, leave carry-over, loan rules + per-employee
  overrides, leave types, holidays, employees & users management
- Reports (all six from BRD 6.6) as Excel downloads
- Audit log (every create/update/approval/login)
- In-app notifications + the three background jobs (leave-year closing,
  SLA escalation, "leave starts tomorrow" reminder)

## Known gaps (deferred — all **S**/**C** priority in the BRD, not **M**)

- **NF-11 data import**: no bulk Excel import tool for initial employee/
  balance/loan data. Employees are added one at a time via Settings → Users
  and roles, which covers the same need at smaller scale.
- **LV-17 team calendar**: not built.
- **AP-05 bulk approve**: not built (priority **C**).
- **LN-14**: outstanding loan balance isn't auto-flagged when an employee's
  status changes to terminated.
- **CO-07 carry-over preview report**: not built.
- **NF-09 Hijri date display**: Gregorian only (Hijri was optional).
- **V2 items explicitly out of scope per the BRD**: payroll file export
  (Finance marks deductions manually), GOSI/Qiwa/Mudad/bank integration,
  AD/LDAP login, email notifications (in-app only).
