import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getRecentNotifications, markAllRead } from "../services/notificationService";

export const notificationsRouter = Router();

notificationsRouter.get("/notifications/recent", requireAuth, (req, res) => {
  const items = getRecentNotifications(req.session.user!.userId, 10);
  res.json({ items });
});

notificationsRouter.post("/notifications/mark-read", requireAuth, (req, res) => {
  markAllRead(req.session.user!.userId);
  res.json({ ok: true });
});
