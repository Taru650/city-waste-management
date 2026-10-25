import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../../common/auth-user';
import { PiiCryptoService } from '../../common/crypto/pii-crypto.service';
import { Role } from '../../common/enums';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AuditService } from '../audit/audit.service';
import { formatComplaintNo } from '../complaints/complaint-number';
import { NOTICE, NOTICE_VERSION, PURPOSE } from './notice';
import { ConsentDto, CorrectProfileDto } from './privacy.dto';

/** Read notifications older than this are deleted; unread ones after twice as long. */
export const NOTIFICATION_RETENTION_DAYS = 180;
/** Spent or revoked session tokens are kept this long for incident investigation, then deleted. */
export const SESSION_RETENTION_DAYS = 30;

/** DPDP Act 2023 rights for citizens: notice, consent, access, correction, erasure. */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly ds: DataSource,
    private readonly pii: PiiCryptoService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  notice() {
    return { version: NOTICE_VERSION, purpose: PURPOSE, grievanceOfficer: this.config.grievanceOfficer, ...NOTICE };
  }

  async consentCurrent(userId: string): Promise<boolean> {
    const [c] = await this.ds.query(
      `SELECT 1 FROM consents WHERE user_id = $1 AND purpose = $2 AND notice_version = $3 AND withdrawn_at IS NULL LIMIT 1`,
      [userId, PURPOSE, NOTICE_VERSION],
    );
    return !!c;
  }

  /** Records consent to the current notice (registration, or re-consent after the notice changed). */
  async recordConsent(userId: string, dto: ConsentDto, m?: EntityManager) {
    if (dto.noticeVersion !== NOTICE_VERSION) {
      throw new ConflictException(`The privacy notice has changed (current version ${NOTICE_VERSION}); please read it again`);
    }
    await (m ?? this.ds).query(`INSERT INTO consents (user_id, purpose, notice_version, language) VALUES ($1, $2, $3, $4)`, [userId, PURPOSE, NOTICE_VERSION, dto.language]);
    await this.audit.log({ actorId: userId, action: 'CONSENT_GIVEN', entity: 'user', entityId: userId, meta: { version: NOTICE_VERSION, language: dto.language } }, m);
  }

  async consent(user: AuthUser, dto: ConsentDto) {
    this.citizenOnly(user);
    if (await this.consentCurrent(user.id)) return { version: NOTICE_VERSION };
    await this.recordConsent(user.id, dto);
    return { version: NOTICE_VERSION };
  }

  /** Right of access: everything held about the citizen, in one machine-readable document. */
  async export(user: AuthUser) {
    this.citizenOnly(user);
    const [u] = await this.ds.query(
      `SELECT u.name, u.guardian_name, u.mobile_enc, u.email_enc, u.preferred_language, u.status, u.created_at, u.last_login_at,
              w.number AS ward_number, ul.name AS ulb_name, d.name AS district_name
         FROM users u LEFT JOIN wards w ON w.id = u.home_ward_id LEFT JOIN ulbs ul ON ul.id = u.home_ulb_id
         LEFT JOIN districts d ON d.id = u.home_district_id
        WHERE u.id = $1`,
      [user.id],
    );
    const consents = await this.ds.query(
      `SELECT purpose, notice_version AS "noticeVersion", language, granted_at AS "grantedAt", withdrawn_at AS "withdrawnAt"
         FROM consents WHERE user_id = $1 ORDER BY granted_at`,
      [user.id],
    );
    const complaints = await this.ds.query(
      `SELECT c.id, c.complaint_no, c.status, t.name_en AS type, c.description, c.landmark,
              ST_Y(c.location) AS lat, ST_X(c.location) AS lng, ul.name AS ulb, w.number AS ward, c.created_at, c.resolved_at, c.closed_at,
              (SELECT json_agg(json_build_object('action', e.action, 'status', e.to_status, 'at', e.created_at) ORDER BY e.id)
                 FROM complaint_events e WHERE e.complaint_id = c.id) AS history,
              (SELECT json_agg(json_build_object('rating', f.rating, 'remark', f.remark, 'reopenRequested', f.reopen_requested, 'at', f.created_at))
                 FROM feedback f WHERE f.complaint_id = c.id) AS feedback,
              (SELECT json_agg(json_build_object('kind', cm.kind, 'stage', cm.stage, 'capturedAt', cm.captured_at,
                                                 'lat', ST_Y(cm.location), 'lng', ST_X(cm.location)) ORDER BY cm.captured_at)
                 FROM complaint_media cm WHERE cm.complaint_id = c.id AND cm.owner_id = $1) AS "yourMedia"
         FROM complaints c JOIN complaint_types t ON t.id = c.type_id JOIN ulbs ul ON ul.id = c.ulb_id JOIN wards w ON w.id = c.ward_id
        WHERE c.citizen_id = $1 ORDER BY c.created_at`,
      [user.id],
    );
    const devices = await this.ds.query(
      `SELECT platform, app_version AS "appVersion", integrity_verdict AS "integrityVerdict", created_at AS "registeredAt",
              last_used_at AS "lastUsedAt", revoked_at AS "revokedAt" FROM devices WHERE user_id = $1 ORDER BY created_at`,
      [user.id],
    );
    const notifications = await this.ds.query(
      `SELECT type, title_en AS title, body_en AS body, created_at AS "createdAt", read_at AS "readAt"
         FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000`,
      [user.id],
    );
    await this.audit.log({ actorId: user.id, action: 'DATA_EXPORTED', entity: 'user', entityId: user.id });
    return {
      generatedAt: new Date().toISOString(),
      noticeVersion: NOTICE_VERSION,
      profile: {
        name: u.name, guardianName: u.guardian_name, mobile: u.mobile_enc ? this.pii.decrypt(u.mobile_enc) : null,
        email: u.email_enc ? this.pii.decrypt(u.email_enc) : null, language: u.preferred_language, status: u.status,
        home: { district: u.district_name, ulb: u.ulb_name, ward: u.ward_number }, createdAt: u.created_at, lastSignInAt: u.last_login_at,
      },
      consents,
      complaints: complaints.map((c: Record<string, unknown>) => ({
        complaintNo: formatComplaintNo(c.complaint_no as string), status: c.status, type: c.type, description: c.description, landmark: c.landmark,
        location: { lat: Number(c.lat), lng: Number(c.lng) }, ulb: c.ulb, ward: c.ward,
        createdAt: c.created_at, resolvedAt: c.resolved_at, closedAt: c.closed_at,
        history: c.history ?? [], feedback: c.feedback ?? [], yourMedia: c.yourMedia ?? [],
      })),
      devices,
      notifications,
    };
  }

  /** Right of correction: name, father/husband name, email. The mobile number is the account identity. */
  async correct(user: AuthUser, dto: CorrectProfileDto) {
    this.citizenOnly(user);
    let emailEnc: string | undefined;
    let emailHash: string | undefined;
    if (dto.email) {
      emailHash = this.pii.blindIndex(dto.email);
      const [taken] = await this.ds.query(`SELECT 1 FROM users WHERE email_hash = $1 AND id <> $2`, [emailHash, user.id]);
      if (taken) throw new ConflictException('This email is already used by another account');
      emailEnc = this.pii.encrypt(dto.email);
    }
    await this.ds.query(
      `UPDATE users SET name = COALESCE($2, name),
              guardian_name = CASE WHEN $3::boolean THEN $4 ELSE guardian_name END,
              email_enc = COALESCE($5, email_enc), email_hash = COALESCE($6, email_hash), updated_at = now()
        WHERE id = $1`,
      [user.id, dto.name ?? null, dto.guardianName !== undefined, dto.guardianName ?? null, emailEnc ?? null, emailHash ?? null],
    ).catch((err) => {
      // Two accounts racing for the same new email: the unique index decides.
      if (err.code === '23505') throw new ConflictException('This email is already used by another account');
      throw err;
    });
    await this.audit.log({ actorId: user.id, action: 'PROFILE_CORRECTED', entity: 'user', entityId: user.id, meta: { fields: Object.keys(dto) } });
  }

  /**
   * Right of erasure (also how consent is withdrawn: the account has no other purpose). Contact
   * details and free-text remarks go immediately; complaints stay as anonymous public records.
   */
  async erase(user: AuthUser, password: string, ip?: string) {
    if (user.role !== Role.CITIZEN) throw new ForbiddenException('Staff accounts are closed by your administrator');
    const [u] = await this.ds.query(`SELECT password_hash FROM users WHERE id = $1 AND erased_at IS NULL`, [user.id]);
    // 400, not 401: the session is valid, and clients treat 401 as "session expired" (same as change-password).
    if (!u || !(await argon2.verify(u.password_hash, password))) throw new BadRequestException('Password is incorrect');
    await this.ds.transaction(async (m) => {
      await m.query(
        `UPDATE users SET name = 'Deleted user', guardian_name = NULL, mobile_enc = NULL, mobile_hash = NULL, email_enc = NULL,
                email_hash = NULL, password_hash = '!erased', status = 'DISABLED', token_version = token_version + 1,
                mfa_secret_enc = NULL, erased_at = now(), updated_at = now()
          WHERE id = $1`,
        [user.id],
      );
      await m.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
      await m.query(`UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
      await m.query(`DELETE FROM push_tokens WHERE user_id = $1`, [user.id]);
      await m.query(`DELETE FROM notifications WHERE user_id = $1`, [user.id]);
      await m.query(`DELETE FROM password_resets WHERE user_id = $1`, [user.id]);
      await m.query(`UPDATE consents SET withdrawn_at = now() WHERE user_id = $1 AND withdrawn_at IS NULL`, [user.id]);
      await m.query(`UPDATE feedback SET remark = NULL WHERE complaint_id IN (SELECT id FROM complaints WHERE citizen_id = $1)`, [user.id]);
      await this.audit.log({ actorId: user.id, action: 'ACCOUNT_ERASED', entity: 'user', entityId: user.id, ip }, m);
    });
  }

  /** Daily housekeeping: data kept only as long as needed. */
  async purge() {
    const n = await this.ds.query(
      `DELETE FROM notifications WHERE (read_at IS NOT NULL AND created_at < now() - make_interval(days => $1))
                                    OR created_at < now() - make_interval(days => $1 * 2)`,
      [NOTIFICATION_RETENTION_DAYS],
    );
    const t = await this.ds.query(
      `DELETE FROM refresh_tokens WHERE (expires_at < now() OR revoked_at IS NOT NULL) AND created_at < now() - make_interval(days => $1)`,
      [SESSION_RETENTION_DAYS],
    );
    return { notifications: n[1] ?? 0, sessions: t[1] ?? 0 };
  }

  private citizenOnly(user: AuthUser) {
    if (user.role !== Role.CITIZEN) throw new ForbiddenException('Available to citizens only');
  }
}
