import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/auth-user';
import { PiiCryptoService } from '../../common/crypto/pii-crypto.service';
import { CREATABLE_ROLES, MFA_REQUIRED_ROLES, Role, UserStatus } from '../../common/enums';
import { assertCanManageUlb } from '../../common/scope';
import { AuditService } from '../audit/audit.service';
import { ARGON2_OPTIONS } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { CreateStaffDto, UpdateStatusDto } from './dto/users.dto';

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** 12-char temporary password with at least one letter and one digit. */
export function generateTempPassword(): string {
  for (;;) {
    const pw = Array.from({ length: 12 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('');
    if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

interface TargetRow {
  id: string;
  role: Role;
  district_id: string | null;
  ulb_id: string | null;
  home_ulb_id: string | null;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly ds: DataSource,
    private readonly pii: PiiCryptoService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /** Staff are created one level down the hierarchy, inside the creator's jurisdiction. */
  async createStaff(actor: AuthUser, dto: CreateStaffDto, ip?: string) {
    if (!CREATABLE_ROLES[actor.role].includes(dto.role)) throw new ForbiddenException(`You cannot create a ${dto.role}`);

    let districtId: string | null = null;
    let ulbId: string | null = null;
    let areaId: string | null = null;
    if (dto.role === Role.DISTRICT_ADMIN) {
      if (!dto.districtId) throw new BadRequestException('districtId is required');
      const [d] = await this.ds.query(`SELECT id FROM districts WHERE id = $1`, [dto.districtId]);
      if (!d) throw new NotFoundException('District not found');
      districtId = d.id;
    } else if (dto.role === Role.SUB_ADMIN) {
      if (!dto.ulbId) throw new BadRequestException('ulbId is required');
      const ulb = await assertCanManageUlb(this.ds, actor, dto.ulbId);
      districtId = ulb.district_id;
      ulbId = ulb.id;
    } else {
      // Supervisor / worker: always in the Sub Admin's own ULB, whatever the client sent.
      districtId = actor.districtId;
      ulbId = actor.ulbId;
      if (dto.areaId) {
        const [a] = await this.ds.query(`SELECT id FROM areas WHERE id = $1 AND ulb_id = $2`, [dto.areaId, ulbId]);
        if (!a) throw new BadRequestException('Area must belong to your ULB');
        areaId = a.id;
      }
    }

    let accessExpiresAt: Date | null = null;
    if (dto.accessExpiresAt) {
      if (dto.role !== Role.SUPERVISOR && dto.role !== Role.WORKER) throw new BadRequestException('Only supervisors and workers can be temporary');
      accessExpiresAt = new Date(dto.accessExpiresAt);
      if (accessExpiresAt <= new Date()) throw new BadRequestException('accessExpiresAt must be in the future');
      if (accessExpiresAt.getTime() - Date.now() > 366 * 86_400_000) throw new BadRequestException('Temporary access can last at most one year');
    }

    // The unique index alone misses an account still indexed under the previous key during a key rotation.
    const [taken] = await this.ds.query(`SELECT 1 FROM users WHERE mobile_hash = ANY($1) OR email_hash = ANY($2)`, [
      this.pii.blindIndexes(dto.mobile), dto.email ? this.pii.blindIndexes(dto.email) : [],
    ]);
    if (taken) throw new ConflictException('Mobile number or email already registered');

    const tempPassword = generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword, ARGON2_OPTIONS);
    const [row] = await this.ds
      .query(
        `INSERT INTO users (role, status, name, mobile_enc, mobile_hash, email_enc, email_hash, password_hash,
                            must_change_password, district_id, ulb_id, area_id, created_by, access_expires_at)
         VALUES ($1, 'ACTIVE', $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          dto.role, dto.name, this.pii.encrypt(dto.mobile), this.pii.blindIndex(dto.mobile),
          dto.email ? this.pii.encrypt(dto.email) : null, dto.email ? this.pii.blindIndex(dto.email) : null,
          passwordHash, districtId, ulbId, areaId, actor.id, accessExpiresAt,
        ],
      )
      .catch((err) => {
        if (err.code === '23505') throw new ConflictException('Mobile number or email already registered');
        throw err;
      });
    await this.audit.log({ actorId: actor.id, action: 'STAFF_CREATED', entity: 'user', entityId: row.id, ip, meta: { role: dto.role, ulbId, districtId } });
    // Shown once to the creating admin; the user must change it at first login.
    return { id: row.id, tempPassword };
  }

  async list(actor: AuthUser, role?: Role) {
    const where: string[] = [`role <> 'CITIZEN'`];
    const params: unknown[] = [];
    if (actor.role === Role.DISTRICT_ADMIN) {
      params.push(actor.districtId);
      where.push(`district_id = $${params.length}`);
    } else if (actor.role === Role.SUB_ADMIN) {
      params.push(actor.ulbId);
      where.push(`ulb_id = $${params.length}`);
    }
    if (role) {
      params.push(role);
      where.push(`role = $${params.length}`);
    }
    const rows = await this.ds.query(
      `SELECT id, role, status, name, mobile_enc, district_id, ulb_id, area_id, mfa_enabled, last_login_at, created_at, access_expires_at
         FROM users WHERE ${where.join(' AND ')} ORDER BY role, name LIMIT 1000`,
      params,
    );
    return rows.map((r: Record<string, string>) => ({
      id: r.id, role: r.role, status: r.status, name: r.name, mobile: this.pii.decrypt(r.mobile_enc),
      districtId: r.district_id, ulbId: r.ulb_id, areaId: r.area_id, mfaEnabled: r.mfa_enabled,
      lastLoginAt: r.last_login_at, createdAt: r.created_at, accessExpiresAt: r.access_expires_at,
    }));
  }

  /** Active workers of the caller's ULB, for the assignment dropdown (supervisors and Sub Admins). */
  async workers(actor: AuthUser) {
    return this.ds.query(
      `SELECT u.id, u.name, u.area_id AS "areaId", a.name AS "areaName",
              (SELECT count(*)::int FROM complaints c WHERE c.worker_id = u.id AND c.status IN ('ASSIGNED','WORK_IN_PROGRESS','REOPENED')) AS "openTasks"
         FROM users u LEFT JOIN areas a ON a.id = u.area_id
        WHERE u.role = 'WORKER' AND u.status = 'ACTIVE' AND u.ulb_id = $1
          AND (u.access_expires_at IS NULL OR u.access_expires_at > now())
        ORDER BY u.name`,
      [actor.ulbId],
    );
  }

  async setStatus(actor: AuthUser, targetId: string, dto: UpdateStatusDto, ip?: string) {
    const target = await this.loadManageable(actor, targetId);
    await this.ds.transaction(async (m) => {
      await m.query(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1`, [target.id, dto.status]);
      if (dto.status === UserStatus.DISABLED) await this.sessions.revokeAll(target.id, m);
      await this.audit.log({ actorId: actor.id, action: `USER_${dto.status}`, entity: 'user', entityId: target.id, ip }, m);
    });
    return { id: target.id, status: dto.status };
  }

  /** Helpdesk reset: issues a temporary password and signs the user out everywhere. */
  async helpdeskResetPassword(actor: AuthUser, targetId: string, ip?: string) {
    const target = await this.loadManageable(actor, targetId);
    const tempPassword = generateTempPassword();
    const hash = await argon2.hash(tempPassword, ARGON2_OPTIONS);
    await this.ds.transaction(async (m) => {
      await m.query(
        `UPDATE users SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL,
                updated_at = now() WHERE id = $1`,
        [target.id, hash],
      );
      await this.sessions.revokeAll(target.id, m);
      await this.audit.log({ actorId: actor.id, action: 'HELPDESK_PASSWORD_RESET', entity: 'user', entityId: target.id, ip }, m);
    });
    return { id: target.id, tempPassword };
  }

  /**
   * Lost authenticator and no recovery codes: the manager one level up clears MFA. The user
   * is signed out everywhere and must enrol a new authenticator at next login.
   */
  async resetMfa(actor: AuthUser, targetId: string, ip?: string) {
    const target = await this.loadManageable(actor, targetId);
    if (!MFA_REQUIRED_ROLES.includes(target.role)) throw new BadRequestException('This user does not use MFA');
    await this.ds.transaction(async (m) => {
      await m.query(
        `UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = NULL, updated_at = now() WHERE id = $1`,
        [target.id],
      );
      await m.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [target.id]);
      await this.sessions.revokeAll(target.id, m);
      await this.audit.log({ actorId: actor.id, action: 'MFA_RESET_BY_ADMIN', entity: 'user', entityId: target.id, ip }, m);
    });
    return { id: target.id };
  }

  /**
   * The actor may manage users one level below them in their own jurisdiction;
   * a Sub Admin additionally runs the citizen helpdesk for their ULB.
   * Anything else is reported as "not found" so IDs cannot be probed.
   */
  private async loadManageable(actor: AuthUser, targetId: string): Promise<TargetRow> {
    const [t]: TargetRow[] = await this.ds.query(
      `SELECT id, role, district_id, ulb_id, home_ulb_id FROM users WHERE id = $1`,
      [targetId],
    );
    const ok =
      !!t &&
      t.id !== actor.id &&
      ((CREATABLE_ROLES[actor.role].includes(t.role) &&
        (actor.role === Role.WEB_ADMIN ||
          (actor.role === Role.DISTRICT_ADMIN && t.district_id === actor.districtId) ||
          (actor.role === Role.SUB_ADMIN && t.ulb_id === actor.ulbId))) ||
        (actor.role === Role.SUB_ADMIN && t.role === Role.CITIZEN && t.home_ulb_id === actor.ulbId));
    if (!ok) throw new NotFoundException('User not found');
    return t;
  }
}
