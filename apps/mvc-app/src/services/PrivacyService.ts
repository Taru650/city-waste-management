import { db } from '@/db/connection';
import { getConfig } from '@/config/env';
import { blindIndex, decrypt, encrypt } from '@/lib/crypto';
import { badRequest, conflict, forbidden } from '@/lib/errors';
import { formatComplaintNo } from '@/lib/complaintNumber';
import { newId } from '@/lib/ids';
import { CONSENT_PURPOSE, NOTICE, NOTICE_VERSION } from '@/lib/notice';
import { verifyPassword } from '@/lib/password';
import { AuditModel } from '@/models/AuditModel';
import { PrivacyModel } from '@/models/PrivacyModel';
import { ConsentModel, SessionModel } from '@/models/SessionModel';
import { UserModel } from '@/models/UserModel';
import type { AuthUser } from '@/middleware/auth';
import { SessionService } from './SessionService';

/** Read notifications older than this are deleted; unread ones after twice as long. */
export const NOTIFICATION_RETENTION_DAYS = 180;
/** Spent or revoked session tokens are kept this long for incident investigation, then deleted. */
export const SESSION_RETENTION_DAYS = 30;

const citizenOnly = (user: AuthUser) => {
  if (user.role !== 'CITIZEN') throw forbidden('Available to citizens only');
};

type Row = Record<string, any>;  
const groupBy = (rows: Row[], key: string) => {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const { [key]: id, ...rest } = r;
    (m.get(id) ?? m.set(id, []).get(id)!).push(rest);
  }
  return m;
};

/** DPDP Act 2023 rights for citizens: notice, consent, access, correction, erasure. */
export const PrivacyService = {
  notice() {
    return { version: NOTICE_VERSION, purpose: CONSENT_PURPOSE, grievanceOfficer: getConfig().grievanceOfficer, ...NOTICE };
  },

  async consent(user: AuthUser, v: { noticeVersion: string; language: 'hi' | 'en' }) {
    citizenOnly(user);
    if (v.noticeVersion !== NOTICE_VERSION) throw conflict(`The privacy notice has changed (current version ${NOTICE_VERSION}); please read it again`);
    if (!(await ConsentModel.isCurrent(db(), user.id, CONSENT_PURPOSE, NOTICE_VERSION))) {
      await db().transaction(async (trx) => {
        await ConsentModel.record(trx, { id: newId(), userId: user.id, purpose: CONSENT_PURPOSE, noticeVersion: NOTICE_VERSION, language: v.language });
        await AuditModel.log(trx, { actorId: user.id, action: 'CONSENT_GIVEN', entity: 'user', entityId: user.id, meta: { version: NOTICE_VERSION, language: v.language } });
      });
    }
    return { version: NOTICE_VERSION };
  },

  /** Right of access: everything held about the citizen, in one machine-readable document. */
  async export(user: AuthUser) {
    citizenOnly(user);
    const d = db();
    const [u, consents, complaints, history, feedback, media, devices, notifications] = await Promise.all([
      UserModel.exportProfile(d, user.id),
      ConsentModel.list(d, user.id),
      PrivacyModel.complaintsOf(d, user.id),
      PrivacyModel.historyOf(d, user.id),
      PrivacyModel.feedbackOf(d, user.id),
      PrivacyModel.mediaOf(d, user.id),
      PrivacyModel.devicesOf(d, user.id),
      PrivacyModel.notificationsOf(d, user.id),
    ]);
    await AuditModel.log(d, { actorId: user.id, action: 'DATA_EXPORTED', entity: 'user', entityId: user.id });
    const h = groupBy(history, 'complaint_id');
    const f = groupBy(feedback, 'complaint_id');
    const m = groupBy(media, 'complaint_id');
    return {
      generatedAt: new Date().toISOString(),
      noticeVersion: NOTICE_VERSION,
      profile: {
        name: u!.name, guardianName: u!.guardian_name, mobile: u!.mobile_enc ? decrypt(u!.mobile_enc) : null,
        email: u!.email_enc ? decrypt(u!.email_enc) : null, language: u!.preferred_language, status: u!.status,
        home: { district: u!.district_name, ulb: u!.ulb_name, ward: u!.ward_number }, createdAt: u!.created_at, lastSignInAt: u!.last_login_at,
      },
      consents,
      complaints: complaints.map((c) => ({
        complaintNo: formatComplaintNo(c.complaint_no), status: c.status, type: c.type, description: c.description, landmark: c.landmark,
        location: { lat: Number(c.lat), lng: Number(c.lng) }, ulb: c.ulb, ward: c.ward,
        createdAt: c.created_at, resolvedAt: c.resolved_at, closedAt: c.closed_at,
        history: h.get(c.id) ?? [], feedback: (f.get(c.id) ?? []).map((x) => ({ ...x, reopenRequested: !!x.reopenRequested })), yourMedia: m.get(c.id) ?? [],
      })),
      devices,
      notifications,
    };
  },

  /** Right of correction: name, father/husband name, email. The mobile number is the account identity. */
  async correct(user: AuthUser, v: { name?: string; guardianName?: string | null; email?: string }) {
    citizenOnly(user);
    const change: Parameters<typeof UserModel.correctProfile>[2] = { name: v.name, guardianName: v.guardianName };
    if (v.email) {
      change.emailHash = blindIndex(v.email);
      if (await UserModel.emailTakenByOther(db(), change.emailHash, user.id)) throw conflict('This email is already used by another account');
      change.emailEnc = encrypt(v.email);
    }
    try {
      await UserModel.correctProfile(db(), user.id, change);
    } catch (err) {
      // Two accounts racing for the same new email: the unique index decides.
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw conflict('This email is already used by another account');
      throw err;
    }
    await AuditModel.log(db(), { actorId: user.id, action: 'PROFILE_CORRECTED', entity: 'user', entityId: user.id, meta: { fields: Object.keys(v) } });
  },

  /**
   * Right of erasure (also how consent is withdrawn: the account has no other purpose). Contact details and free-text
   * remarks go immediately; complaints stay as anonymous public records.
   */
  async erase(user: AuthUser, password: string, ip: string | null) {
    if (user.role !== 'CITIZEN') throw forbidden('Staff accounts are closed by your administrator');
    const u = await UserModel.findForLoginById(db(), user.id);
    // 400, not 401: the session is valid, and clients treat 401 as "session expired" (same as change-password).
    if (!u || u.erased_at || !(await verifyPassword(u.password_hash, password))) throw badRequest('Password is incorrect');
    await db().transaction(async (trx) => {
      await UserModel.eraseIdentity(trx, user.id);
      await SessionService.revokeEverything(trx, user.id); // sessions, device keys, push tokens, live access tokens
      await PrivacyModel.eraseRelated(trx, user.id);
      await ConsentModel.withdrawAll(trx, user.id);
      await AuditModel.log(trx, { actorId: user.id, action: 'ACCOUNT_ERASED', entity: 'user', entityId: user.id, ip });
    });
  },

  /** Daily housekeeping: data kept only as long as needed. */
  async purge() {
    const notifications = await PrivacyModel.purgeNotifications(db(), NOTIFICATION_RETENTION_DAYS);
    const sessions = await SessionModel.purge(db(), SESSION_RETENTION_DAYS);
    const passwordResets = await PrivacyModel.purgePasswordResets(db());
    return { notifications, sessions, passwordResets };
  },
};
