import type { Request, Response } from "express";
import { config } from "../../src/config";
import { runDailyJobs } from "../../src/jobs";

// Hit once a day by Vercel Cron (see vercel.json). Vercel signs these requests with
// an Authorization: Bearer <CRON_SECRET> header matching the CRON_SECRET env var,
// so this checks that instead of trusting the request outright — this endpoint would
// otherwise be a public, unauthenticated way to trigger leave-year closing, SLA
// escalation notifications, etc. on demand.
export default async function handler(req: Request, res: Response) {
  const authHeader = req.headers.authorization;
  if (!config.cronSecret || authHeader !== `Bearer ${config.cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    await runDailyJobs();
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Daily cron job failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
}
