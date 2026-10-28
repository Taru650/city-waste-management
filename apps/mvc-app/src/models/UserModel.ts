import type { Db } from '@/db/sql';
import { one, query, run } from '@/db/sql';
import type { Role, UserStatus } from '@/lib/enums';

/** Fields the login flow needs. The two flags are computed in SQL, so the database clock decides. */
export interface LoginRow {
  id: string;
  role: Role;
  status: UserStatus;
  password_hash: string;
  token_version: number;
  failed_login_count: number;
  locked: boolean;
  access_expired: boolean;
  email_enc: string | null;
  mobile_enc: string | null;
  erased_at: Date | null;
}

const LOGIN_COLUMNS = `id, role, status, password_hash, token_version, failed_login_count,
  (locked_until IS NOT NULL AND locked_until > NOW(3)) AS locked,
  (access_expires_at IS NOT NULL AND access_expires_at <= NOW(3)) AS access_expired,
  email_enc, mobile_enc, erased_at`;

const asLoginRow = (r: LoginRow | undefined): LoginRow | undefined =>
  r && { ...r, locked: !!r.locked, access_expired: !!r.access_expired };

export interface NewUser {
  id: string;
  role: Role;
  status: UserStatus;
  name: string;
  guardianName?: string | null;
  mobileEnc: string;
  mobileHash: string;
  emailEnc?: string | null;
  emailHash?: string | null;
  passwordHash: string;
  mustChangePassword?: boolean;
  preferredLanguage?: 'hi' | 'en';
  districtId?: string | null;
  ulbId?: string | null;
  areaId?: string | null;
  homeDistrictId?: string | null;
  homeUlbId?: string | null;
  homeWardId?: string | null;
  createdBy?: string | null;
  accessExpiresAt?: Date | null;
}

export const UserModel = {
  findForLoginByHash(d: Db, hashes: string[]) {
    return one<LoginRow>(d, `SELECT ${LOGIN_COLUMNS} FROM users WHERE mobile_hash IN (?) OR email_hash IN (?) LIMIT 1`, [hashes, hashes]).then(asLoginRow);
  },

  findForLoginById(d: Db, id: string, forUpdate = false) {
    return one<LoginRow>(d, `SELECT ${LOGIN_COLUMNS} FROM users WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [id]).then(asLoginRow);
  },

  async contactTaken(d: Db, mobileHash: string, emailHash: string | null): Promise<boolean> {
    const row = await one(d, `SELECT 1 AS x FROM users WHERE mobile_hash = ? OR (? IS NOT NULL AND email_hash = ?) LIMIT 1`, [mobileHash, emailHash, emailHash]);
    return !!row;
  },

  async insert(d: Db, u: NewUser): Promise<void> {
    await run(
      d,
      `INSERT INTO users (id, role, status, name, guardian_name, mobile_enc, mobile_hash, email_enc, email_hash, password_hash,
                          must_change_password, preferred_language, district_id, ulb_id, area_id,
                          home_district_id, home_ulb_id, home_ward_id, created_by, access_expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        u.id, u.role, u.status, u.name, u.guardianName ?? null, u.mobileEnc, u.mobileHash, u.emailEnc ?? null, u.emailHash ?? null,
        u.passwordHash, u.mustChangePassword ? 1 : 0, u.preferredLanguage ?? 'hi', u.districtId ?? null, u.ulbId ?? null, u.areaId ?? null,
        u.homeDistrictId ?? null, u.homeUlbId ?? null, u.homeWardId ?? null, u.createdBy ?? null, u.accessExpiresAt ?? null,
      ],
    );
  },

  /** Full profile for /auth/me (encrypted fields are decrypted by the service). */
  one(d: Db, id: string) {
    return one(
      d,
      `SELECT id, role, status, name, guardian_name, mobile_enc, email_enc, must_change_password, district_id, ulb_id, area_id,
              home_district_id, home_ulb_id, home_ward_id, created_at, preferred_language
         FROM users WHERE id = ?`,
      [id],
    );
  },

  async completeLogin(d: Db, id: string): Promise<void> {
    await run(d, `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW(3) WHERE id = ?`, [id]);
  },

  /** Counts a failed sign-in and locks the account at the limit. Returns true when this failure locked it. */
  async recordFailure(d: Db, id: string, max: number, lockMinutes: number): Promise<boolean> {
    await run(
      d,
      // MySQL evaluates SET assignments left to right: locked_until must be computed before the counter changes.
      `UPDATE users SET locked_until = CASE WHEN failed_login_count + 1 >= ? THEN DATE_ADD(NOW(3), INTERVAL ? MINUTE) ELSE locked_until END,
              failed_login_count = failed_login_count + 1
        WHERE id = ?`,
      [max, lockMinutes, id],
    );
    const row = await one<{ failed_login_count: number }>(d, `SELECT failed_login_count FROM users WHERE id = ?`, [id]);
    if (row && row.failed_login_count >= max) {
      await run(d, `UPDATE users SET failed_login_count = 0 WHERE id = ?`, [id]);
      return true;
    }
    return false;
  },

  async setPassword(d: Db, id: string, hash: string, opts: { mustChange: boolean; clearLock?: boolean }): Promise<void> {
    await run(
      d,
      `UPDATE users SET password_hash = ?, must_change_password = ?${opts.clearLock ? ', failed_login_count = 0, locked_until = NULL' : ''} WHERE id = ?`,
      [hash, opts.mustChange ? 1 : 0, id],
    );
  },

  async setPreferredLanguage(d: Db, id: string, lang: 'hi' | 'en') {
    await run(d, `UPDATE users SET preferred_language = ? WHERE id = ?`, [lang, id]);
  },

  async setStatus(d: Db, id: string, status: UserStatus) {
    await run(d, `UPDATE users SET status = ? WHERE id = ?`, [status, id]);
  },

  /** Invalidates every access token of the user at once (the token carries the version it was issued under). */
  async bumpTokenVersion(d: Db, id: string) {
    await run(d, `UPDATE users SET token_version = token_version + 1 WHERE id = ?`, [id]);
  },

  async tokenVersion(d: Db, id: string): Promise<number> {
    const r = await one<{ token_version: number }>(d, `SELECT token_version FROM users WHERE id = ?`, [id]);
    return r?.token_version ?? 0;
  },

  listStaff(d: Db, where: string, params: unknown[]) {
    return query(
      d,
      `SELECT id, role, status, name, mobile_enc, district_id, ulb_id, area_id, last_login_at, created_at, access_expires_at
         FROM users WHERE role <> 'CITIZEN'${where} ORDER BY role, name LIMIT 1000`,
      params,
    );
  },

  workers(d: Db, ulbId: string) {
    return query(
      d,
      `SELECT u.id, u.name, u.area_id AS areaId, a.name AS areaName,
              (SELECT COUNT(*) FROM complaints c WHERE c.worker_id = u.id AND c.status IN ('ASSIGNED','WORK_IN_PROGRESS','REOPENED')) AS openTasks
         FROM users u LEFT JOIN areas a ON a.id = u.area_id
        WHERE u.role = 'WORKER' AND u.status = 'ACTIVE' AND u.ulb_id = ?
          AND (u.access_expires_at IS NULL OR u.access_expires_at > NOW(3))
        ORDER BY u.name`,
      [ulbId],
    );
  },

  target(d: Db, id: string) {
    return one<{ id: string; role: Role; district_id: string | null; ulb_id: string | null; home_ulb_id: string | null }>(
      d,
      `SELECT id, role, district_id, ulb_id, home_ulb_id FROM users WHERE id = ?`,
      [id],
    );
  },
};
