import { db, asRow } from "../db";
import type { NotificationRow } from "../models/types";

export async function notify(userId: number, eventType: string, messageEn: string, messageAr: string, linkUrl: string | null = null): Promise<void> {
  await db.prepare(
    `INSERT INTO notifications (user_id, event_type, message_en, message_ar, link_url)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, eventType, messageEn, messageAr, linkUrl);
}

export async function getUnreadCount(userId: number): Promise<number> {
  const row = (await db
    .prepare("SELECT COUNT(*) as n FROM notifications WHERE user_id = ? AND is_read = 0")
    .get(userId)) as { n: number };
  return row.n;
}

export async function getRecentNotifications(userId: number, limit = 10): Promise<NotificationRow[]> {
  return asRow<NotificationRow[]>(
    await db
      .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit)
  );
}

export async function markAllRead(userId: number): Promise<void> {
  await db.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ?").run(userId);
}
