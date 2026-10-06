# Raseel MC — Leave & Loan Management Platform

Internal, on-premise web app for Raseel Medical Center: employees see their
leave balance, request leave, request salary-deducted loans, and every
request routes through an admin-configurable approval workflow. Built from
`Raseel-MC-BRD.pdf` and `Raseel-MC-Screen-Designs.pdf`.

## Tech stack

Node.js + TypeScript + Express, server-rendered EJS views, Postgres (hosted
on [Neon](https://neon.tech)) via `pg`, deployed on [Vercel](https://vercel.com).
Bilingual English/Arabic with RTL layout. Fonts are self-hosted (no Google
Fonts CDN call) and Bootstrap's CSS has been replaced by a custom design
system — only its JS bundle is kept (self-hosted), for the `.collapse`/
`.dropdown` interactions.

The app originally ran on SQLite (`node:sqlite`) for fully on-prem, no-DB-
server hosting — see `.claude/plans/` conversation history for that
reasoning. It has since moved to Postgres/Neon/Vercel; this trades the
"internal network only" hosting posture for Vercel's public-internet
hosting, same tradeoff already made earlier via a temporary Cloudflare
tunnel, now permanent. Authentication/RBAC are unchanged either way.

Sessions are stored in Postgres (`connect-pg-simple`, auto-creates a
`user_sessions` table) rather than in-process memory, since Vercel's
serverless functions share no memory between invocations. Background jobs
(leave-year closing, SLA escalation, "leave tomorrow" reminder) run via
Vercel Cron hitting `/api/cron/daily` in production, or `node-cron` directly
when running locally/on-prem (`src/server.ts`).

## Running it locally

Prerequisites: Node.js 22.5+, and a Postgres connection string (Neon's free
tier works fine for development — use the **pooled** connection string from
its dashboard, not the direct one).

```bash
cp .env.example .env   # fill in DATABASE_URL (and SESSION_SECRET) in .env
npm install
npm run migrate  # applies the schema to DATABASE_URL
npm run seed     # seeds test data (skips if already seeded)
npm run dev      # starts the dev server with auto-reload at http://localhost:3000
```

For a production-style run (no file-watching):

```bash
npm run build
npm start
```

## Deploying (Vercel + Neon)

1. Create a Neon project and copy its **pooled** connection string into
   `DATABASE_URL`.
2. In the Vercel project's environment variables, set `DATABASE_URL`,
   `SESSION_SECRET`, and `CRON_SECRET` (any long random string — Vercel signs
   its daily cron request with it automatically once it's set).
3. Run `npm run migrate` once (locally, with `DATABASE_URL` pointed at Neon)
   to apply the schema, then `npm run seed` if it's a fresh database.
4. Push to the connected GitHub repo — Vercel builds `api/index.ts` as the
   serverless entry point (see `vercel.json`) and deploys automatically.

Migrations are **not** run automatically on deploy or on cold start (to avoid
concurrent invocations racing to apply the same migration) — re-run
`npm run migrate` by hand after pulling schema changes.

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

## Backups (NF-05)

Neon takes continuous backups itself (point-in-time restore, varies by
plan) — there's no separate backup script to run now that the database
isn't a local file. `scripts/backup-db.ps1` is left over from the SQLite
setup and no longer applies.

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
