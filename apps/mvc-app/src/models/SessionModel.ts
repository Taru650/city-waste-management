import type { Db } from '@/db/sql';
import { one, run } from '@/db/sql';
import type { Role, UserStatus } from '@/lib/enums';

export interface RotationRow {
  id: string;
  family_id: string;
  used_at: Date | null;
  revoked_at: Date | null;
  expired: boolean;
  user_id: string;
  role: Role;
  status: UserStatus;
  token_version: number;
  access_expired: boolean;
}

/** Login sessions. Refresh tokens are stored as SHA-256 hashes; a session is a "family" of rotated tokens. */
export const SessionModel = {
  async insertRefresh(d: Db, v: { id: string; userId: string; familyId: string; tokenHash: string; days: number; ip: string | null; userAgent: string | null }) {
    await run(
      d,
      `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? DAY), ?, ?)`,
      [v.id, v.userId, v.familyId, v.tokenHash, v.days, v.ip?.slice(0, 64) ?? null, v.userAgent?.slice(0, 255) ?? null],
    );
  },

  /** Locks the token's row so two parallel refreshes cannot both succeed. */
  async findForRotation(d: Db, tokenHash: string): Promise<RotationRow | undefined> {
    const r = await one<RotationRow>(
      d,
      `SELECT rt.id, rt.family_id, rt.used_at, rt.revoked_at, (rt.expires_at < NOW(3)) AS expired,
              u.id AS user_id, u.role, u.status, u.token_version,
              (u.access_expires_at IS NOT NULL AND u.access_expires_at <= NOW(3)) AS access_expired
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = ? FOR UPDATE`,
      [tokenHash],
    );
    return r && { ...r, expired: !!r.expired, access_expired: !!r.access_expired };
  },

  async markUsed(d: Db, id: string) {
    await run(d, `UPDATE refresh_tokens SET used_at = NOW(3) WHERE id = ?`, [id]);
  },

  async revokeFamily(d: Db, familyId: string) {
    await run(d, `UPDATE refresh_tokens SET revoked_at = NOW(3) WHERE family_id = ? AND revoked_at IS NULL`, [familyId]);
  },

  /** Sign out of one device: the session the given refresh token belongs to. */
  async revokeFamilyOfToken(d: Db, tokenHash: string) {
    await run(
      d,
      `UPDATE refresh_tokens SET revoked_at = NOW(3)
        WHERE revoked_at IS NULL AND family_id = (SELECT family_id FROM (SELECT family_id FROM refresh_tokens WHERE token_hash = ?) t)`,
      [tokenHash],
    );
  },

  /**
   * Sign out everywhere: every session, every device signing key and push token, and every live access
   * token (they carry the token version, which moves on).
   */
  async revokeEverything(d: Db, userId: string) {
    await run(d, `UPDATE refresh_tokens SET revoked_at = NOW(3) WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
    await run(d, `UPDATE devices SET revoked_at = NOW(3) WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
    await run(d, `DELETE FROM push_tokens WHERE user_id = ?`, [userId]);
    await run(d, `UPDATE users SET token_version = token_version + 1 WHERE id = ?`, [userId]);
  },

  /** Housekeeping: expired or revoked tokens older than N days. */
  async purge(d: Db, days: number): Promise<number> {
    const r = await run(d, `DELETE FROM refresh_tokens WHERE (expires_at < NOW(3) OR revoked_at IS NOT NULL) AND created_at < DATE_SUB(NOW(3), INTERVAL ? DAY)`, [days]);
    return r.affectedRows;
  },
};

export const PasswordResetModel = {
  async supersede(d: Db, userId: string) {
    await run(d, `UPDATE password_resets SET used_at = NOW(3) WHERE user_id = ? AND used_at IS NULL`, [userId]);
  },
  async insert(d: Db, v: { id: string; userId: string; tokenHash: string; minutes: number }) {
    await run(d, `INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? MINUTE))`, [v.id, v.userId, v.tokenHash, v.minutes]);
  },
  findValidForUpdate(d: Db, tokenHash: string) {
    return one<{ id: string; user_id: string }>(d, `SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW(3) FOR UPDATE`, [tokenHash]);
  },
};

export const ConsentModel = {
  async record(d: Db, v: { id: string; userId: string; purpose: string; noticeVersion: string; language: 'hi' | 'en' }) {
    await run(d, `INSERT INTO consents (id, user_id, purpose, notice_version, language) VALUES (?,?,?,?,?)`, [v.id, v.userId, v.purpose, v.noticeVersion, v.language]);
  },
  async isCurrent(d: Db, userId: string, purpose: string, noticeVersion: string): Promise<boolean> {
    return !!(await one(d, `SELECT 1 AS x FROM consents WHERE user_id = ? AND purpose = ? AND notice_version = ? AND withdrawn_at IS NULL LIMIT 1`, [userId, purpose, noticeVersion]));
  },
};
