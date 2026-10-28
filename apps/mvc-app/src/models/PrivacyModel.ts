import type { Db } from '@/db/sql';
import { query, run } from '@/db/sql';

/** Everything held about a citizen, for the right of access; and the erasure and retention statements. */
export const PrivacyModel = {
  complaintsOf(d: Db, citizenId: string) {
    return query(
      d,
      `SELECT c.id, c.complaint_no, c.status, t.name_en AS type, c.description, c.landmark, c.lat, c.lng,
              ul.name AS ulb, w.number AS ward, c.created_at, c.resolved_at, c.closed_at
         FROM complaints c JOIN complaint_types t ON t.id = c.type_id JOIN ulbs ul ON ul.id = c.ulb_id JOIN wards w ON w.id = c.ward_id
        WHERE c.citizen_id = ? ORDER BY c.created_at, c.id`,
      [citizenId],
    );
  },
  historyOf(d: Db, citizenId: string) {
    return query(
      d,
      `SELECT e.complaint_id, e.action, e.to_status AS status, e.created_at AS at
         FROM complaint_events e JOIN complaints c ON c.id = e.complaint_id WHERE c.citizen_id = ? ORDER BY e.id`,
      [citizenId],
    );
  },
  feedbackOf(d: Db, citizenId: string) {
    return query(
      d,
      `SELECT f.complaint_id, f.rating, f.remark, f.reopen_requested AS reopenRequested, f.created_at AS at
         FROM feedback f JOIN complaints c ON c.id = f.complaint_id WHERE c.citizen_id = ? ORDER BY f.created_at, f.id`,
      [citizenId],
    );
  },
  mediaOf(d: Db, citizenId: string) {
    return query(
      d,
      `SELECT m.complaint_id, m.kind, m.stage, m.captured_at AS capturedAt, ST_Latitude(m.location) AS lat, ST_Longitude(m.location) AS lng
         FROM complaint_media m JOIN complaints c ON c.id = m.complaint_id WHERE c.citizen_id = ? AND m.owner_id = ? ORDER BY m.captured_at, m.id`,
      [citizenId, citizenId],
    );
  },
  devicesOf(d: Db, userId: string) {
    return query(
      d,
      `SELECT platform, app_version AS appVersion, integrity_verdict AS integrityVerdict, created_at AS registeredAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt
         FROM devices WHERE user_id = ? ORDER BY created_at, id`,
      [userId],
    );
  },
  notificationsOf(d: Db, userId: string) {
    return query(d, `SELECT type, title_en AS title, body_en AS body, created_at AS createdAt, read_at AS readAt FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1000`, [userId]);
  },

  /** Removes what erasure requires besides the identity itself. Complaints stay as anonymous records. */
  async eraseRelated(d: Db, userId: string) {
    await run(d, `DELETE FROM notifications WHERE user_id = ?`, [userId]);
    await run(d, `DELETE FROM password_resets WHERE user_id = ?`, [userId]);
    await run(d, `UPDATE feedback SET remark = NULL WHERE complaint_id IN (SELECT id FROM complaints WHERE citizen_id = ?)`, [userId]);
  },

  /** Read notifications older than `days` go, unread ones after twice as long; spent password-reset links after a day. */
  async purgeNotifications(d: Db, days: number): Promise<number> {
    const r = await run(
      d,
      `DELETE FROM notifications WHERE (read_at IS NOT NULL AND created_at < DATE_SUB(NOW(3), INTERVAL ? DAY)) OR created_at < DATE_SUB(NOW(3), INTERVAL ? DAY)`,
      [days, days * 2],
    );
    return r.affectedRows;
  },
  async purgePasswordResets(d: Db): Promise<number> {
    const r = await run(d, `DELETE FROM password_resets WHERE (used_at IS NOT NULL OR expires_at < NOW(3)) AND created_at < DATE_SUB(NOW(3), INTERVAL 1 DAY)`);
    return r.affectedRows;
  },
};
