import { db } from '@/db/connection';
import { badRequest, conflict, forbidden, isDuplicateKey, notFound } from '@/lib/errors';
import { blindIndex, decrypt, encrypt } from '@/lib/crypto';
import { CREATABLE_ROLES, type Role } from '@/lib/enums';
import { newId } from '@/lib/ids';
import { generateTempPassword, hashPassword } from '@/lib/password';
import { AuditModel } from '@/models/AuditModel';
import { AreaModel, DistrictModel } from '@/models/MasterModel';
import { UserModel } from '@/models/UserModel';
import type { AuthUser } from '@/middleware/auth';
import { SessionService } from './SessionService';
import { assertCanManageUlb } from './ScopeService';

const MAX_TEMPORARY_ACCESS_MS = 366 * 86_400_000;

interface CreateStaffInput {
  role: string;
  name: string;
  mobile: string;
  email?: string;
  districtId?: string;
  ulbId?: string;
  areaId?: string;
  accessExpiresAt?: string;
}

/**
 * The actor may manage users one level below them in their own jurisdiction; a Sub Admin additionally runs
 * the citizen helpdesk for their ULB. Anything else is reported as "not found", so IDs cannot be probed.
 */
async function loadManageable(actor: AuthUser, targetId: string) {
  const t = await UserModel.target(db(), targetId);
  const ok =
    !!t &&
    t.id !== actor.id &&
    ((CREATABLE_ROLES[actor.role].includes(t.role) &&
      (actor.role === 'WEB_ADMIN' ||
        (actor.role === 'DISTRICT_ADMIN' && t.district_id === actor.districtId) ||
        (actor.role === 'SUB_ADMIN' && t.ulb_id === actor.ulbId))) ||
      (actor.role === 'SUB_ADMIN' && t.role === 'CITIZEN' && t.home_ulb_id === actor.ulbId));
  if (!ok) throw notFound('User not found');
  return t;
}

export const UserService = {
  /** Staff are created one level down the hierarchy, inside the creator's jurisdiction. */
  async createStaff(actor: AuthUser, input: CreateStaffInput, ip: string | null) {
    const role = input.role as Role;
    if (!CREATABLE_ROLES[actor.role].includes(role)) throw forbidden(`You cannot create a ${role}`);

    let districtId: string | null = null;
    let ulbId: string | null = null;
    let areaId: string | null = null;
    if (role === 'DISTRICT_ADMIN') {
      if (!input.districtId) throw badRequest('districtId is required');
      const d = await DistrictModel.find(db(), input.districtId);
      if (!d) throw notFound('District not found');
      districtId = d.id;
    } else if (role === 'SUB_ADMIN') {
      if (!input.ulbId) throw badRequest('ulbId is required');
      const ulb = await assertCanManageUlb(db(), actor, input.ulbId);
      districtId = ulb.district_id;
      ulbId = ulb.id;
    } else {
      // Supervisor / worker: always in the Sub Admin's own ULB, whatever the client sent.
      districtId = actor.districtId;
      ulbId = actor.ulbId;
      if (input.areaId) {
        const area = await AreaModel.find(db(), input.areaId);
        if (!area || area.ulb_id !== ulbId) throw badRequest('Area must belong to your ULB');
        areaId = area.id;
      }
    }

    let accessExpiresAt: Date | null = null;
    if (input.accessExpiresAt) {
      if (role !== 'SUPERVISOR' && role !== 'WORKER') throw badRequest('Only supervisors and workers can be temporary');
      accessExpiresAt = new Date(input.accessExpiresAt);
      if (accessExpiresAt <= new Date()) throw badRequest('accessExpiresAt must be in the future');
      if (accessExpiresAt.getTime() - Date.now() > MAX_TEMPORARY_ACCESS_MS) throw badRequest('Temporary access can last at most one year');
    }

    const mobileHash = blindIndex(input.mobile);
    const emailHash = input.email ? blindIndex(input.email) : null;
    const taken = 'Mobile number or email already registered';
    if (await UserModel.contactTaken(db(), mobileHash, emailHash)) throw conflict(taken);

    const tempPassword = generateTempPassword();
    const id = newId();
    try {
      await UserModel.insert(db(), {
        id, role, status: 'ACTIVE', name: input.name,
        mobileEnc: encrypt(input.mobile), mobileHash,
        emailEnc: input.email ? encrypt(input.email) : null, emailHash,
        passwordHash: await hashPassword(tempPassword), mustChangePassword: true,
        districtId, ulbId, areaId, createdBy: actor.id, accessExpiresAt,
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw conflict(taken);
      throw err;
    }
    await AuditModel.log(db(), { actorId: actor.id, action: 'STAFF_CREATED', entity: 'user', entityId: id, ip, meta: { role, ulbId, districtId } });
    // Shown once to the creating admin; the user must change it at first sign-in.
    return { id, tempPassword };
  },

  async list(actor: AuthUser, role?: Role) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (actor.role === 'DISTRICT_ADMIN') {
      where.push(' AND district_id = ?');
      params.push(actor.districtId);
    } else if (actor.role === 'SUB_ADMIN') {
      where.push(' AND ulb_id = ?');
      params.push(actor.ulbId);
    }
    if (role) {
      where.push(' AND role = ?');
      params.push(role);
    }
    const rows = await UserModel.listStaff(db(), where.join(''), params);
    return rows.map((r) => ({
      id: r.id, role: r.role, status: r.status, name: r.name, mobile: r.mobile_enc ? decrypt(r.mobile_enc) : null,
      districtId: r.district_id, ulbId: r.ulb_id, areaId: r.area_id, mfaEnabled: false,
      lastLoginAt: r.last_login_at, createdAt: r.created_at, accessExpiresAt: r.access_expires_at,
    }));
  },

  /** Active workers of the caller's ULB, for the assignment dropdown (supervisors and Sub Admins). */
  async workers(actor: AuthUser) {
    if (!actor.ulbId) return [];
    const rows = await UserModel.workers(db(), actor.ulbId);
    return rows.map((r) => ({ ...r, openTasks: Number(r.openTasks) }));
  },

  async setStatus(actor: AuthUser, targetId: string, status: 'ACTIVE' | 'DISABLED', ip: string | null) {
    const target = await loadManageable(actor, targetId);
    await db().transaction(async (trx) => {
      await UserModel.setStatus(trx, target.id, status);
      if (status === 'DISABLED') await SessionService.revokeEverything(trx, target.id);
      await AuditModel.log(trx, { actorId: actor.id, action: `USER_${status}`, entity: 'user', entityId: target.id, ip });
    });
    return { id: target.id, status };
  },

  /** Helpdesk reset: issues a temporary password, clears any lockout and signs the user out everywhere. */
  async helpdeskResetPassword(actor: AuthUser, targetId: string, ip: string | null) {
    const target = await loadManageable(actor, targetId);
    const tempPassword = generateTempPassword();
    const hash = await hashPassword(tempPassword);
    await db().transaction(async (trx) => {
      await UserModel.setPassword(trx, target.id, hash, { mustChange: true, clearLock: true });
      await SessionService.revokeEverything(trx, target.id);
      await AuditModel.log(trx, { actorId: actor.id, action: 'HELPDESK_PASSWORD_RESET', entity: 'user', entityId: target.id, ip });
    });
    return { id: target.id, tempPassword };
  },
};
