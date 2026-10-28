import { db } from '@/db/connection';
import { getConfig } from '@/config/env';
import { blindIndex, decrypt, encrypt, newOpaqueToken, sha256 } from '@/lib/crypto';
import { conflict, badRequest, isDuplicateKey, unauthorized } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { sendMail } from '@/lib/mail';
import { CONSENT_PURPOSE, NOTICE_VERSION } from '@/lib/notice';
import { assertStrongPassword, dummyHash, hashPassword, verifyPassword } from '@/lib/password';
import type { ClientInfo } from '@/middleware/http';
import { AuditModel } from '@/models/AuditModel';
import { ConsentModel, PasswordResetModel } from '@/models/SessionModel';
import { UserModel, type LoginRow } from '@/models/UserModel';
import { one } from '@/db/sql';
import { SessionService, type SessionTokens } from './SessionService';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
export const RESET_TOKEN_MINUTES = 15;

export interface RegisterInput {
  homeWardId: string;
  name: string;
  guardianName?: string;
  mobile: string;
  email: string;
  password: string;
  consentNoticeVersion: string;
  consentLanguage?: 'hi' | 'en';
}

const invalidCredentials = () => unauthorized('Invalid credentials');

export const AuthService = {
  async registerCitizen(input: RegisterInput, client: ClientInfo): Promise<SessionTokens> {
    assertStrongPassword(input.password, { mobile: input.mobile, email: input.email });
    const ward = await one<{ id: string; ulb_id: string; district_id: string }>(
      db(),
      `SELECT w.id, w.ulb_id, u.district_id FROM wards w JOIN ulbs u ON u.id = w.ulb_id WHERE w.id = ? AND w.active AND u.active`,
      [input.homeWardId],
    );
    if (!ward) throw badRequest('Unknown ward');
    if (input.consentNoticeVersion !== NOTICE_VERSION) {
      throw conflict(`The privacy notice has changed (current version ${NOTICE_VERSION}); please read it again`);
    }
    const mobileHash = blindIndex(input.mobile);
    const emailHash = blindIndex(input.email);
    // Registration has to say something on a clash; the generic wording plus rate limits limit enumeration.
    const taken = 'An account with this mobile number or email already exists';
    if (await UserModel.contactTaken(db(), mobileHash, emailHash)) throw conflict(taken);

    const passwordHash = await hashPassword(input.password);
    const lang = input.consentLanguage ?? 'hi';
    try {
      // Account, consent record and first session together: DPDP, no processing without recorded consent.
      return await db().transaction(async (trx) => {
        const id = newId();
        await UserModel.insert(trx, {
          id, role: 'CITIZEN', status: 'UNVERIFIED_MOBILE', name: input.name, guardianName: input.guardianName ?? null,
          mobileEnc: encrypt(input.mobile), mobileHash, emailEnc: encrypt(input.email), emailHash, passwordHash,
          preferredLanguage: lang, homeDistrictId: ward.district_id, homeUlbId: ward.ulb_id, homeWardId: ward.id,
        });
        await ConsentModel.record(trx, { id: newId(), userId: id, purpose: CONSENT_PURPOSE, noticeVersion: NOTICE_VERSION, language: lang });
        await AuditModel.log(trx, { actorId: id, action: 'CITIZEN_REGISTERED', entity: 'user', entityId: id, ip: client.ip });
        return SessionService.issue(trx, { id, role: 'CITIZEN', token_version: 0 }, client);
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw conflict(taken);
      throw err;
    }
  },

  async login(identifier: string, password: string, client: ClientInfo): Promise<SessionTokens> {
    const user = await UserModel.findForLoginByHash(db(), [blindIndex(identifier)]);
    // Same work and same answer for "no such user", "locked", "disabled" and "wrong password".
    if (!user || user.locked || user.status === 'DISABLED' || user.access_expired || user.erased_at) {
      await verifyPassword(await dummyHash(), password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(user.password_hash, password))) {
      const locked = await UserModel.recordFailure(db(), user.id, MAX_FAILED_LOGINS, LOCKOUT_MINUTES);
      if (locked) await AuditModel.log(db(), { actorId: user.id, action: 'ACCOUNT_LOCKED', entity: 'user', entityId: user.id, ip: client.ip });
      throw invalidCredentials();
    }
    await UserModel.completeLogin(db(), user.id);
    await AuditModel.log(db(), { actorId: user.id, action: 'LOGIN', entity: 'user', entityId: user.id, ip: client.ip });
    return SessionService.issue(db(), { id: user.id, role: user.role, token_version: user.token_version }, client);
  },

  async changePassword(userId: string, currentPassword: string, newPassword: string, client: ClientInfo): Promise<SessionTokens> {
    const user = await UserModel.findForLoginById(db(), userId);
    if (!user || !(await verifyPassword(user.password_hash, currentPassword))) throw badRequest('Current password is incorrect');
    if (currentPassword === newPassword) throw badRequest('New password must be different');
    assertStrongPassword(newPassword, contactsOf(user));
    const hash = await hashPassword(newPassword);
    return db().transaction(async (trx) => {
      await SessionService.revokeEverything(trx, user.id);
      await UserModel.setPassword(trx, user.id, hash, { mustChange: false });
      await AuditModel.log(trx, { actorId: user.id, action: 'PASSWORD_CHANGED', entity: 'user', entityId: user.id, ip: client.ip });
      const version = await UserModel.tokenVersion(trx, user.id);
      return SessionService.issue(trx, { id: user.id, role: user.role, token_version: version }, client);
    });
  },

  /** Always resolves the same way, whether or not the account exists (no user enumeration). */
  async forgotPassword(identifier: string, client: ClientInfo): Promise<void> {
    const user = await UserModel.findForLoginByHash(db(), [blindIndex(identifier)]);
    if (!user || user.status === 'DISABLED' || !user.email_enc || user.erased_at) return;
    const token = newOpaqueToken();
    await db().transaction(async (trx) => {
      await PasswordResetModel.supersede(trx, user.id); // only the newest link is valid
      await PasswordResetModel.insert(trx, { id: newId(), userId: user.id, tokenHash: sha256(token), minutes: RESET_TOKEN_MINUTES });
      await AuditModel.log(trx, { actorId: user.id, action: 'PASSWORD_RESET_REQUESTED', entity: 'user', entityId: user.id, ip: client.ip });
    });
    const link = `${getConfig().passwordResetUrl}?token=${encodeURIComponent(token)}`;
    // A mail outage must not change the response (that would reveal that the account exists).
    await sendMail({
      to: decrypt(user.email_enc),
      subject: 'Password reset / पासवर्ड रीसेट',
      text: `Use this link within ${RESET_TOKEN_MINUTES} minutes to set a new password:\n${link}\n\nIf you did not ask for this, ignore this email.`,
    }).catch((err) => console.error('[auth] password reset mail failed:', (err as Error).message));
  },

  async resetPassword(token: string, newPassword: string, client: ClientInfo): Promise<void> {
    await db().transaction(async (trx) => {
      const reset = await PasswordResetModel.findValidForUpdate(trx, sha256(token));
      if (!reset) throw badRequest('Reset link is invalid or has expired');
      const user = await UserModel.findForLoginById(trx, reset.user_id);
      if (!user) throw badRequest('Reset link is invalid or has expired');
      assertStrongPassword(newPassword, contactsOf(user));
      const hash = await hashPassword(newPassword);
      await PasswordResetModel.supersede(trx, user.id);
      await UserModel.setPassword(trx, user.id, hash, { mustChange: false, clearLock: true });
      await SessionService.revokeEverything(trx, user.id);
      await AuditModel.log(trx, { actorId: user.id, action: 'PASSWORD_RESET', entity: 'user', entityId: user.id, ip: client.ip });
    });
  },

  async me(userId: string) {
    const u = await UserModel.one(db(), userId);
    if (!u) throw unauthorized();
    const consentRequired = u.role === 'CITIZEN' ? !(await ConsentModel.isCurrent(db(), u.id, CONSENT_PURPOSE, NOTICE_VERSION)) : false;
    return {
      id: u.id, role: u.role, status: u.status, name: u.name, guardianName: u.guardian_name,
      mobile: u.mobile_enc ? decrypt(u.mobile_enc) : null, email: u.email_enc ? decrypt(u.email_enc) : null,
      mustChangePassword: !!u.must_change_password,
      // This edition has no second factor; the fields stay so existing clients keep parsing the response.
      mfaEnabled: false, recoveryCodesRemaining: null,
      preferredLanguage: u.preferred_language,
      districtId: u.district_id, ulbId: u.ulb_id, areaId: u.area_id,
      homeDistrictId: u.home_district_id, homeUlbId: u.home_ulb_id, homeWardId: u.home_ward_id,
      createdAt: u.created_at, consentRequired,
    };
  },

  async setPreferences(userId: string, preferredLanguage: 'hi' | 'en') {
    await UserModel.setPreferredLanguage(db(), userId, preferredLanguage);
    return this.me(userId);
  },
};

function contactsOf(user: LoginRow) {
  return { mobile: user.mobile_enc ? decrypt(user.mobile_enc) : undefined, email: user.email_enc ? decrypt(user.email_enc) : undefined };
}

