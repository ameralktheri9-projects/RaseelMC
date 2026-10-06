import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { getRecentNotifications, markAllRead } from "../services/notificationService";

export const notificationsRouter = Router();

notificationsRouter.get(
  "/notifications/recent",
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await getRecentNotifications(req.session.user!.userId, 10);
    res.json({ items });
  })
);

notificationsRouter.post(
  "/notifications/mark-read",
  requireAuth,
  asyncHandler(async (req, res) => {
    await markAllRead(req.session.user!.userId);
    res.json({ ok: true });
  })
);
