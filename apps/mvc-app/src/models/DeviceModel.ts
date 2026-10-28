import type { Db } from '@/db/sql';
import { one, query, run } from '@/db/sql';

export const DeviceModel = {
  findByFingerprint(d: Db, fingerprint: string, forUpdate = false) {
    return one<{ id: string; user_id: string }>(d, `SELECT id, user_id FROM devices WHERE key_fingerprint = ?${forUpdate ? ' FOR UPDATE' : ''}`, [fingerprint]);
  },
  async insert(d: Db, v: { id: string; userId: string; publicKey: string; fingerprint: string; platform: string; appVersion?: string | null }) {
    await run(d, `INSERT INTO devices (id, user_id, public_key, key_fingerprint, platform, app_version) VALUES (?,?,?,?,?,?)`, [v.id, v.userId, v.publicKey, v.fingerprint, v.platform, v.appVersion ?? null]);
  },
  async touch(d: Db, id: string, appVersion?: string | null) {
    await run(d, `UPDATE devices SET revoked_at = NULL, app_version = ?, last_used_at = NOW(3) WHERE id = ?`, [appVersion ?? null, id]);
  },
  /** Keep only the most recent installs active. */
  async trimActive(d: Db, userId: string, keep: number) {
    await run(
      d,
      `UPDATE devices SET revoked_at = NOW(3)
        WHERE user_id = ? AND revoked_at IS NULL AND id NOT IN (
          SELECT id FROM (SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY COALESCE(last_used_at, created_at) DESC, id LIMIT ?) newest)`,
      [userId, userId, keep],
    );
  },
  list(d: Db, userId: string) {
    return query(
      d,
      `SELECT id, platform, app_version AS appVersion, integrity_verdict AS integrityVerdict, created_at AS createdAt, last_used_at AS lastUsedAt
         FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id`,
      [userId],
    );
  },
  async revoke(d: Db, userId: string, id: string): Promise<boolean> {
    const r = await run(d, `UPDATE devices SET revoked_at = NOW(3) WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, [id, userId]);
    return r.affectedRows > 0;
  },
  findActive(d: Db, userId: string, id: string) {
    return one<{ id: string }>(d, `SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, [id, userId]);
  },
};
