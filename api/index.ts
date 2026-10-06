import { createApp } from "../src/app";

// Vercel serverless entry point. Unlike src/server.ts (used for local dev / on-prem `npm start`),
// this never calls app.listen() or schedules node-cron jobs — Vercel invokes the exported Express
// app directly per-request, and background jobs run via Vercel Cron hitting api/cron/daily.ts
// instead. Migrations are run explicitly (`npm run migrate` against DATABASE_URL), not on every
// cold start, to avoid concurrent invocations racing to apply the same migration.
export default createApp();
