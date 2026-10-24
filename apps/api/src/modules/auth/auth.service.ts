import { BadRequestException, ConflictException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { DataSource } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { MfaTokenClaims } from '../../common/auth-user';
import { MFA_REQUIRED_ROLES, Role, UserStatus } from '../../common/enums';
import { PiiCryptoService } from '../../common/crypto/pii-crypto.service';
import { newOpaqueToken, sha256 } from '../../common/crypto/tokens';
import { randomInt } from 'crypto';
import { mutateReturning } from '../../common/db';
import { AuditService } from '../audit/audit.service';
import { ChangePasswordDto, LoginDto, RegisterCitizenDto, ResetPasswordDto } from './dto/auth.dto';
import { MAIL_SERVICE, MailService } from './mail.service';
import { assertStrongPassword } from './password-policy';
import { ClientInfo, SessionService, SessionTokens } from './session.service';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
export const RESET_TOKEN_MINUTES = 15;
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MFA_TOKEN_TTL_SECONDS = 300;

/** OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1). */
export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export type LoginResult =
  | ({ status: 'OK' } & SessionTokens)
  | { status: 'MFA_REQUIRED'; mfaToken: string }
  | { status: 'MFA_ENROLLMENT_REQUIRED'; mfaToken: string };

interface UserRow {
  id: string;
  role: Role;
  status: UserStatus;
  password_hash: string;
  token_version: number;
  failed_login_count: number;
  locked: boolean;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  mfa_last_step: string | null;
  email_enc: string | null;
  mobile_enc: string;
}

/** Codes are case-insensitive and may be typed with or without the dash. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

const USER_COLUMNS = `id, role, status, password_hash, token_version, failed_login_count,
  (locked_until IS NOT NULL AND locked_until > now()) AS locked,
  mfa_enabled, mfa_secret_enc, mfa_last_step, email_enc, mobile_enc`;

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  /** Verified against when the user does not exist, so response time does not reveal accounts. */
  private dummyHash: Promise<string>;

  constructor(
    private readonly ds: DataSource,
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
    private readonly pii: PiiCryptoService,
    private readonly audit: AuditService,
    @Inject(MAIL_SERVICE) private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.dummyHash = argon2.hash(newOpaqueToken(), ARGON2_OPTIONS);
  }

  async registerCitizen(dto: RegisterCitizenDto, client: ClientInfo) {
    assertStrongPassword(dto.password, { mobile: dto.mobile, email: dto.email });
    const [ward] = await this.ds.query(
      `SELECT w.id, w.ulb_id, u.district_id FROM wards w JOIN ulbs u ON u.id = w.ulb_id
        WHERE w.id = $1 AND w.active AND u.active`,
      [dto.homeWardId],
    );
    if (!ward) throw new BadRequestException('Unknown ward');

    const mobileHash = this.pii.blindIndex(dto.mobile);
    const emailHash = this.pii.blindIndex(dto.email);
    const [taken] = await this.ds.query(`SELECT 1 FROM users WHERE mobile_hash = $1 OR email_hash = $2`, [mobileHash, emailHash]);
    // Registration has to say *something* on a clash; the generic wording plus rate limits limit enumeration.
    if (taken) throw new ConflictException('An account with this mobile number or email already exists');

    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);
    const [user] = await this.ds.query(
      `INSERT INTO users (role, status, name, guardian_name, mobile_enc, mobile_hash, email_enc, email_hash,
                          password_hash, home_district_id, home_ulb_id, home_ward_id)
       VALUES ('CITIZEN', 'UNVERIFIED_MOBILE', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id, role, token_version`,
      [
        dto.name, dto.guardianName ?? null, this.pii.encrypt(dto.mobile), mobileHash,
        this.pii.encrypt(dto.email), emailHash, passwordHash, ward.district_id, ward.ulb_id, ward.id,
      ],
    );
    if (!user) throw new ConflictException('An account with this mobile number or email already exists');
    await this.audit.log({ actorId: user.id, action: 'CITIZEN_REGISTERED', entity: 'user', entityId: user.id, ip: client.ip });
    return this.sessions.issue(user, client);
  }

  async login(dto: LoginDto, client: ClientInfo): Promise<LoginResult> {
    const user = await this.findByIdentifier(dto.identifier);
    if (!user) {
      await argon2.verify(await this.dummyHash, dto.password).catch(() => false);
      throw this.invalidCredentials();
    }
    if (user.locked || user.status === UserStatus.DISABLED) {
      await argon2.verify(await this.dummyHash, dto.password).catch(() => false);
      throw this.invalidCredentials();
    }
    if (!(await argon2.verify(user.password_hash, dto.password))) {
      await this.recordFailure(user, client);
      throw this.invalidCredentials();
    }

    if (MFA_REQUIRED_ROLES.includes(user.role)) {
      const stage = user.mfa_enabled ? 'verify' : 'enroll';
      const mfaToken = await this.signMfaToken(user.id, stage);
      return user.mfa_enabled ? { status: 'MFA_REQUIRED', mfaToken } : { status: 'MFA_ENROLLMENT_REQUIRED', mfaToken };
    }
    return { status: 'OK', ...(await this.completeLogin(user, client)) };
  }

  /** Step 1 of TOTP enrolment: generate a secret for the authenticator app. */
  async mfaEnroll(mfaToken: string) {
    const claims = await this.verifyMfaToken(mfaToken, 'enroll');
    const secret = authenticator.generateSecret(20);
    const [row] = await mutateReturning(
      this.ds,
      `UPDATE users SET mfa_secret_enc = $2, updated_at = now() WHERE id = $1 AND NOT mfa_enabled RETURNING id`,
      [claims.sub, this.pii.encrypt(secret)],
    );
    if (!row) throw new UnauthorizedException();
    return { secret, otpauthUrl: authenticator.keyuri(claims.sub, 'CityWasteMgmt', secret) };
  }

  /**
   * Step 2 of enrolment: prove the authenticator works, then sign in. Returns one-time
   * recovery codes (shown once) for when the phone with the authenticator is lost.
   */
  async mfaActivate(mfaToken: string, code: string, client: ClientInfo): Promise<SessionTokens & { recoveryCodes: string[] }> {
    const claims = await this.verifyMfaToken(mfaToken, 'enroll');
    const user = await this.findById(claims.sub);
    if (!user?.mfa_secret_enc || user.mfa_enabled) throw new UnauthorizedException();
    await this.checkTotp(user, code, client);
    await this.ds.query(`UPDATE users SET mfa_enabled = true, updated_at = now() WHERE id = $1`, [user.id]);
    const recoveryCodes = await this.replaceRecoveryCodes(user.id);
    await this.audit.log({ actorId: user.id, action: 'MFA_ENABLED', entity: 'user', entityId: user.id, ip: client.ip });
    return { ...(await this.completeLogin(user, client)), recoveryCodes };
  }

  /** Sign in with a one-time recovery code instead of the authenticator. */
  async mfaRecover(mfaToken: string, recoveryCode: string, client: ClientInfo): Promise<SessionTokens & { recoveryCodesRemaining: number }> {
    const claims = await this.verifyMfaToken(mfaToken, 'verify');
    const user = await this.findById(claims.sub);
    if (!user?.mfa_enabled || user.locked) throw new UnauthorizedException('Invalid code');
    const used = await mutateReturning(
      this.ds,
      `UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
      [user.id, this.pii.blindIndex(normalizeRecoveryCode(recoveryCode))],
    );
    if (!used.length) {
      await this.recordFailure(user, client);
      throw new UnauthorizedException('Invalid code');
    }
    await this.audit.log({ actorId: user.id, action: 'MFA_RECOVERY_CODE_USED', entity: 'user', entityId: user.id, ip: client.ip });
    const [{ remaining }] = await this.ds.query(
      `SELECT count(*)::int AS remaining FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );
    return { ...(await this.completeLogin(user, client)), recoveryCodesRemaining: remaining };
  }

  /** Issue a fresh set of recovery codes (invalidates the old ones). Requires a current TOTP code. */
  async regenerateRecoveryCodes(userId: string, code: string, client: ClientInfo) {
    const user = await this.findById(userId);
    if (!user?.mfa_enabled || !user.mfa_secret_enc) throw new BadRequestException('MFA is not enabled');
    await this.checkTotp(user, code, client);
    const recoveryCodes = await this.replaceRecoveryCodes(user.id);
    await this.audit.log({ actorId: user.id, action: 'MFA_RECOVERY_CODES_REGENERATED', entity: 'user', entityId: user.id, ip: client.ip });
    return { recoveryCodes };
  }

  async setPreferences(userId: string, preferredLanguage: 'hi' | 'en') {
    await this.ds.query(`UPDATE users SET preferred_language = $2, updated_at = now() WHERE id = $1`, [userId, preferredLanguage]);
    return this.me(userId);
  }

  private async replaceRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    await this.ds.transaction(async (m) => {
      await m.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
      await m.query(
        `INSERT INTO mfa_recovery_codes (user_id, code_hash) SELECT $1, h FROM unnest($2::text[]) AS h`,
        [userId, codes.map((c) => this.pii.blindIndex(normalizeRecoveryCode(c)))],
      );
    });
    return codes;
  }

  async mfaVerify(mfaToken: string, code: string, client: ClientInfo): Promise<SessionTokens> {
    const claims = await this.verifyMfaToken(mfaToken, 'verify');
    const user = await this.findById(claims.sub);
    if (!user?.mfa_enabled || !user.mfa_secret_enc) throw new UnauthorizedException();
    await this.checkTotp(user, code, client);
    return this.completeLogin(user, client);
  }

  async changePassword(userId: string, dto: ChangePasswordDto, client: ClientInfo): Promise<SessionTokens> {
    const user = await this.findById(userId);
    if (!user || !(await argon2.verify(user.password_hash, dto.currentPassword))) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (dto.currentPassword === dto.newPassword) throw new BadRequestException('New password must be different');
    assertStrongPassword(dto.newPassword, this.decryptContacts(user));
    const hash = await argon2.hash(dto.newPassword, ARGON2_OPTIONS);
    return this.ds.transaction(async (m) => {
      await this.sessions.revokeAll(user.id, m);
      const [updated] = await mutateReturning(
        m,
        `UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now()
          WHERE id = $1 RETURNING id, role, token_version`,
        [user.id, hash],
      );
      await this.audit.log({ actorId: user.id, action: 'PASSWORD_CHANGED', entity: 'user', entityId: user.id, ip: client.ip }, m);
      return this.sessions.issue(updated, client, undefined, m);
    });
  }

  /** Always resolves the same way, whether or not the account exists (no user enumeration). */
  async forgotPassword(identifier: string, client: ClientInfo): Promise<void> {
    const user = await this.findByIdentifier(identifier);
    if (!user || user.status === UserStatus.DISABLED || !user.email_enc) return;
    const token = newOpaqueToken();
    await this.ds.transaction(async (m) => {
      // Only the newest link is valid.
      await m.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
      await m.query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [user.id, sha256(token), RESET_TOKEN_MINUTES],
      );
      await this.audit.log({ actorId: user.id, action: 'PASSWORD_RESET_REQUESTED', entity: 'user', entityId: user.id, ip: client.ip }, m);
    });
    const link = `${this.config.passwordResetUrl}?token=${encodeURIComponent(token)}`;
    // A mail outage must not change the response (that would reveal the account exists).
    await this.mail.send(
      this.pii.decrypt(user.email_enc),
      'Password reset / पासवर्ड रीसेट',
      `Use this link within ${RESET_TOKEN_MINUTES} minutes to set a new password:\n${link}\n\nIf you did not ask for this, ignore this email.`,
    ).catch((err) => this.logger.error(`Password reset mail failed: ${err}`));
  }

  async resetPassword(dto: ResetPasswordDto, client: ClientInfo): Promise<void> {
    await this.ds.transaction(async (m) => {
      const [reset] = await m.query(
        `SELECT pr.id, pr.user_id FROM password_resets pr
          WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()
          FOR UPDATE`,
        [sha256(dto.token)],
      );
      if (!reset) throw new BadRequestException('Reset link is invalid or has expired');
      const [user] = await m.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [reset.user_id]);
      assertStrongPassword(dto.newPassword, this.decryptContacts(user));
      const hash = await argon2.hash(dto.newPassword, ARGON2_OPTIONS);
      await m.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
      await m.query(
        `UPDATE users SET password_hash = $2, must_change_password = false, failed_login_count = 0,
                locked_until = NULL, updated_at = now() WHERE id = $1`,
        [user.id, hash],
      );
      await this.sessions.revokeAll(user.id, m);
      await this.audit.log({ actorId: user.id, action: 'PASSWORD_RESET', entity: 'user', entityId: user.id, ip: client.ip }, m);
    });
  }

  async me(userId: string) {
    const [u] = await this.ds.query(
      `SELECT id, role, status, name, guardian_name, mobile_enc, email_enc, must_change_password, mfa_enabled,
              district_id, ulb_id, area_id, home_district_id, home_ulb_id, home_ward_id, created_at, preferred_language,
              (SELECT count(*)::int FROM mfa_recovery_codes r WHERE r.user_id = users.id AND r.used_at IS NULL) AS recovery_left
         FROM users WHERE id = $1`,
      [userId],
    );
    return {
      id: u.id, role: u.role, status: u.status, name: u.name, guardianName: u.guardian_name,
      mobile: this.pii.decrypt(u.mobile_enc), email: u.email_enc ? this.pii.decrypt(u.email_enc) : null,
      mustChangePassword: u.must_change_password, mfaEnabled: u.mfa_enabled,
      recoveryCodesRemaining: u.mfa_enabled ? u.recovery_left : null, preferredLanguage: u.preferred_language,
      districtId: u.district_id, ulbId: u.ulb_id, areaId: u.area_id,
      homeDistrictId: u.home_district_id, homeUlbId: u.home_ulb_id, homeWardId: u.home_ward_id,
      createdAt: u.created_at,
    };
  }

  // ---- helpers ----

  private async completeLogin(user: UserRow, client: ClientInfo): Promise<SessionTokens> {
    await this.ds.query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [user.id],
    );
    await this.audit.log({ actorId: user.id, action: 'LOGIN', entity: 'user', entityId: user.id, ip: client.ip });
    return this.sessions.issue(user, client);
  }

  private async recordFailure(user: UserRow, client: ClientInfo) {
    const [row] = await mutateReturning(
      this.ds,
      `UPDATE users SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
        WHERE id = $1 RETURNING failed_login_count`,
      [user.id, MAX_FAILED_LOGINS, LOCKOUT_MINUTES],
    );
    if (row.failed_login_count >= MAX_FAILED_LOGINS) {
      await this.ds.query(`UPDATE users SET failed_login_count = 0 WHERE id = $1`, [user.id]);
      await this.audit.log({ actorId: user.id, action: 'ACCOUNT_LOCKED', entity: 'user', entityId: user.id, ip: client.ip });
    }
  }

  /** TOTP check with ±1 step window, replay protection, and lockout on repeated failures. */
  private async checkTotp(user: UserRow, code: string, client: ClientInfo) {
    if (user.locked) throw this.invalidCredentials();
    const secret = this.pii.decrypt(user.mfa_secret_enc!);
    authenticator.options = { window: 1 };
    const delta = authenticator.checkDelta(code, secret);
    const step = delta === null ? null : Math.floor(Date.now() / 30000) + delta;
    if (step === null || (user.mfa_last_step !== null && step <= Number(user.mfa_last_step))) {
      await this.recordFailure(user, client);
      throw new UnauthorizedException('Invalid code');
    }
    await this.ds.query(`UPDATE users SET mfa_last_step = $2 WHERE id = $1`, [user.id, step]);
  }

  private signMfaToken(userId: string, stage: MfaTokenClaims['stage']) {
    const claims: MfaTokenClaims = { sub: userId, typ: 'mfa', stage };
    return this.jwt.signAsync(claims, { secret: this.config.jwtMfaSecret, algorithm: 'HS256', expiresIn: MFA_TOKEN_TTL_SECONDS });
  }

  private async verifyMfaToken(token: string, stage: MfaTokenClaims['stage']): Promise<MfaTokenClaims> {
    try {
      const claims = await this.jwt.verifyAsync<MfaTokenClaims>(token, { secret: this.config.jwtMfaSecret, algorithms: ['HS256'] });
      if (claims.typ === 'mfa' && claims.stage === stage) return claims;
    } catch {
      // fall through
    }
    throw new UnauthorizedException();
  }

  private async findByIdentifier(identifier: string): Promise<UserRow | undefined> {
    const [row] = await this.ds.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE mobile_hash = $1 OR email_hash = $1 LIMIT 1`,
      [this.pii.blindIndex(identifier)],
    );
    return row;
  }

  private async findById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.ds.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    return row;
  }

  private decryptContacts(user: UserRow) {
    return { mobile: this.pii.decrypt(user.mobile_enc), email: user.email_enc ? this.pii.decrypt(user.email_enc) : undefined };
  }

  private invalidCredentials() {
    return new UnauthorizedException('Invalid credentials');
  }
}
