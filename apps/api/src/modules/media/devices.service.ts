import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/auth-user';
import { mutateReturning } from '../../common/db';
import { Role } from '../../common/enums';
import { AttestationRequired, AttestationService, StoredVerdict } from '../attestation/attestation.service';
import { AuditService } from '../audit/audit.service';
import { keyFingerprint, ManifestError, parseDevicePublicKey } from './capture-manifest';
import { RegisterDeviceDto } from './dto/media.dto';

export const MAX_ACTIVE_DEVICES = 5;
/** A key attested this recently is not re-attested at every login (Play Integrity has a daily quota). */
export const ATTESTATION_VALID_DAYS = 30;
export const PASSING_VERDICTS = ['MEETS_BASIC_INTEGRITY', 'MEETS_DEVICE_INTEGRITY', 'MEETS_STRONG_INTEGRITY'];

/** Registers the app install's signing key. Called by the apps after every login (idempotent). */
@Injectable()
export class DevicesService {
  constructor(private readonly ds: DataSource, private readonly audit: AuditService, private readonly attestation: AttestationService) {}

  async register(user: AuthUser, dto: RegisterDeviceDto, ip?: string) {
    try {
      parseDevicePublicKey(dto.publicKey);
    } catch (err) {
      if (err instanceof ManifestError) throw new BadRequestException(err.message);
      throw err;
    }
    const fingerprint = keyFingerprint(dto.publicKey);
    const verdict = await this.attest(user, dto, fingerprint);
    return this.ds.transaction(async (m) => {
      const [existing] = await m.query(`SELECT id, user_id FROM devices WHERE key_fingerprint = $1 FOR UPDATE`, [fingerprint]);
      let id: string;
      if (existing) {
        if (existing.user_id !== user.id) throw new ConflictException('This device key is registered to another account');
        await m.query(
          `UPDATE devices SET revoked_at = NULL, app_version = $2, last_used_at = now(),
                  integrity_verdict = COALESCE($3, integrity_verdict), integrity_checked_at = CASE WHEN $3 IS NULL THEN integrity_checked_at ELSE now() END
            WHERE id = $1`,
          [existing.id, dto.appVersion ?? null, verdict],
        );
        id = existing.id;
      } else {
        const [row] = await m.query(
          `INSERT INTO devices (user_id, public_key, key_fingerprint, platform, app_version, integrity_verdict, integrity_checked_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [user.id, dto.publicKey, fingerprint, dto.platform, dto.appVersion ?? null, verdict ?? 'UNVERIFIED', verdict ? new Date() : null],
        );
        id = row.id;
        await this.audit.log(
          { actorId: user.id, action: 'DEVICE_REGISTERED', entity: 'device', entityId: id, ip, meta: { platform: dto.platform, integrity: verdict ?? 'UNVERIFIED' } },
          m,
        );
      }
      // Keep only the most recent installs active.
      await m.query(
        `UPDATE devices SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL AND id NOT IN (
            SELECT id FROM devices WHERE user_id = $1 AND revoked_at IS NULL
             ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT $2)`,
        [user.id, MAX_ACTIVE_DEVICES],
      );
      return { id };
    });
  }

  /**
   * Play Integrity for the signing key. Returns the verdict to store, or null when nothing new was
   * checked (attestation off, or this key passed recently). Throws 428 with a challenge when the
   * app must attest; the challenge nonce is bound to the public key.
   */
  private async attest(user: AuthUser, dto: RegisterDeviceDto, fingerprint: string): Promise<StoredVerdict | null> {
    const mode = this.attestation.mode;
    if (mode === 'off') return null;
    if (dto.platform === 'IOS') {
      // App Attest is not implemented yet: iOS keys cannot be vouched for.
      if (mode === 'enforce') throw new ForbiddenException('The iOS app cannot be verified yet; please use the Android app.');
      return 'UNVERIFIED';
    }
    const [recent] = await this.ds.query(
      `SELECT 1 FROM devices WHERE key_fingerprint = $1 AND user_id = $2 AND integrity_verdict = ANY($3)
          AND integrity_checked_at > now() - make_interval(days => $4)`,
      [fingerprint, user.id, PASSING_VERDICTS, ATTESTATION_VALID_DAYS],
    );
    if (recent) return null;
    if (!dto.integrityToken && !dto.attestationError) throw new AttestationRequired(this.attestation.issueChallenge('device').challenge!);
    const app = user.role === Role.CITIZEN ? 'citizen' : 'staff';
    return this.attestation.verify('device', app, dto, dto.publicKey);
  }

  list(user: AuthUser) {
    return this.ds.query(
      `SELECT id, platform, app_version AS "appVersion", integrity_verdict AS "integrityVerdict",
              created_at AS "createdAt", last_used_at AS "lastUsedAt"
         FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [user.id],
    );
  }

  async revoke(user: AuthUser, id: string, ip?: string) {
    const rows = await mutateReturning(
      this.ds,
      `UPDATE devices SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [id, user.id],
    );
    if (!rows.length) throw new NotFoundException('Device not found');
    await this.audit.log({ actorId: user.id, action: 'DEVICE_REVOKED', entity: 'device', entityId: id, ip });
  }
}
