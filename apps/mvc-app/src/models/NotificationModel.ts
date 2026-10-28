import type { Db } from '@/db/sql';
import { one, query, run } from '@/db/sql';
import type { NotificationContent } from '@/lib/notificationTemplates';

export interface PendingPush {
  id: string;
  user_id: string;
  type: string;
  complaint_id: string | null;
  push_attempts: number;
  title: string;
  body: string;
}

export const NotificationModel = {
  async insertMany(d: Db, userIds: string[], c: NotificationContent, complaintId: string | null): Promise<void> {
    if (!userIds.length) return;
    const rows = userIds.map(() => '(?,?,?,?,?,?,?)').join(',');
    const params = userIds.flatMap((u) => [u, c.type, complaintId, c.title.en, c.title.hi, c.body.en, c.body.hi]);
    await run(d, `INSERT INTO notifications (user_id, type, complaint_id, title_en, title_hi, body_en, body_hi) VALUES ${rows}`, params);
  },

  async subAdminIds(d: Db, ulbId: string): Promise<string[]> {
    return (await query<{ id: string }>(d, `SELECT id FROM users WHERE role = 'SUB_ADMIN' AND ulb_id = ? AND status = 'ACTIVE'`, [ulbId])).map((r) => r.id);
  },

  /** Locks a batch of notifications still to be pushed (other workers skip locked rows). Call inside a transaction. */
  claimPending(d: Db, limit: number) {
    return query<PendingPush>(
      d,
      `SELECT n.id, n.user_id, n.type, n.complaint_id, n.push_attempts,
              IF(u.preferred_language = 'en', n.title_en, n.title_hi) AS title,
              IF(u.preferred_language = 'en', n.body_en, n.body_hi) AS body
         FROM notifications n JOIN users u ON u.id = n.user_id
        WHERE n.push_status = 'PENDING'
        ORDER BY n.created_at, n.id LIMIT ?
        FOR UPDATE OF n SKIP LOCKED`,
      [limit],
    );
  },

  tokensOf(d: Db, userId: string) {
    return query<{ id: string; token: string }>(d, `SELECT id, token FROM push_tokens WHERE user_id = ?`, [userId]);
  },
  async deleteTokenById(d: Db, id: string) {
    await run(d, `DELETE FROM push_tokens WHERE id = ?`, [id]);
  },
  async setPushStatus(d: Db, id: string, status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED', attempts: number) {
    await run(d, `UPDATE notifications SET push_status = ?, push_attempts = ? WHERE id = ?`, [status, attempts, id]);
  },

  async count(d: Db, userId: string, unreadOnly: boolean): Promise<number> {
    const r = await one<{ n: number }>(d, `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?${unreadOnly ? ' AND read_at IS NULL' : ''}`, [userId]);
    return Number(r?.n ?? 0);
  },

  list(d: Db, userId: string, unreadOnly: boolean, limit: number, offset: number) {
    return query(
      d,
      `SELECT n.id, n.type, n.complaint_id AS complaintId,
              IF(u.preferred_language = 'en', n.title_en, n.title_hi) AS title,
              IF(u.preferred_language = 'en', n.body_en, n.body_hi) AS body,
              n.read_at AS readAt, n.created_at AS createdAt
         FROM notifications n JOIN users u ON u.id = n.user_id
        WHERE n.user_id = ?${unreadOnly ? ' AND n.read_at IS NULL' : ''}
        ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset],
    );
  },

  async markRead(d: Db, userId: string, id: string): Promise<boolean> {
    await run(d, `UPDATE notifications SET read_at = COALESCE(read_at, NOW(3)) WHERE id = ? AND user_id = ?`, [id, userId]);
    return !!(await one(d, `SELECT 1 AS x FROM notifications WHERE id = ? AND user_id = ?`, [id, userId]));
  },
  async markAllRead(d: Db, userId: string) {
    await run(d, `UPDATE notifications SET read_at = NOW(3) WHERE user_id = ? AND read_at IS NULL`, [userId]);
  },

  /** A token identifies one app install: signing in with another account on the same phone moves it. */
  async upsertToken(d: Db, userId: string, token: string, platform: string) {
    await run(
      d,
      `INSERT INTO push_tokens (user_id, token, platform) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), last_seen_at = NOW(3)`,
      [userId, token, platform],
    );
  },
  async trimTokens(d: Db, userId: string, keep: number) {
    await run(
      d,
      `DELETE FROM push_tokens WHERE user_id = ? AND id NOT IN (
         SELECT id FROM (SELECT id FROM push_tokens WHERE user_id = ? ORDER BY last_seen_at DESC, id LIMIT ?) newest)`,
      [userId, userId, keep],
    );
  },
  async deleteToken(d: Db, userId: string, token: string) {
    await run(d, `DELETE FROM push_tokens WHERE token = ? AND user_id = ?`, [token, userId]);
  },
};
