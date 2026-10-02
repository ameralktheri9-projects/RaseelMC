import { db, asRow } from "../db";
import type { NotificationRow } from "../models/types";

export function notify(userId: number, eventType: string, messageEn: string, messageAr: string, linkUrl: string | null = null): void {
  db.prepare(
    `INSERT INTO notifications (user_id, event_type, message_en, message_ar, link_url)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, eventType, messageEn, messageAr, linkUrl);
}

export function getUnreadCount(userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) as n FROM notifications WHERE user_id = ? AND is_read = 0")
    .get(userId) as { n: number };
  return row.n;
}

export function getRecentNotifications(userId: number, limit = 10): NotificationRow[] {
  return asRow<NotificationRow[]>(
    db
      .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit)
  );
}

export function markAllRead(userId: number): void {
  db.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ?").run(userId);
}
