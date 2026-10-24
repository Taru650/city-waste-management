import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/auth-user';
import { mutateReturning } from '../../common/db';
import { AuditService } from '../audit/audit.service';
import { keyFingerprint, ManifestError, parseDevicePublicKey } from './capture-manifest';
import { RegisterDeviceDto } from './dto/media.dto';

export const MAX_ACTIVE_DEVICES = 5;

/** Registers the app install's signing key. Called by the apps after every login (idempotent). */
@Injectable()
export class DevicesService {
  constructor(private readonly ds: DataSource, private readonly audit: AuditService) {}

  async register(user: AuthUser, dto: RegisterDeviceDto, ip?: string) {
    try {
      parseDevicePublicKey(dto.publicKey);
    } catch (err) {
      if (err instanceof ManifestError) throw new BadRequestException(err.message);
      throw err;
    }
    const fingerprint = keyFingerprint(dto.publicKey);
    return this.ds.transaction(async (m) => {
      const [existing] = await m.query(`SELECT id, user_id FROM devices WHERE key_fingerprint = $1 FOR UPDATE`, [fingerprint]);
      let id: string;
      if (existing) {
        if (existing.user_id !== user.id) throw new ConflictException('This device key is registered to another account');
        await m.query(`UPDATE devices SET revoked_at = NULL, app_version = $2, last_used_at = now() WHERE id = $1`, [existing.id, dto.appVersion ?? null]);
        id = existing.id;
      } else {
        const [row] = await m.query(
          `INSERT INTO devices (user_id, public_key, key_fingerprint, platform, app_version) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [user.id, dto.publicKey, fingerprint, dto.platform, dto.appVersion ?? null],
        );
        id = row.id;
        await this.audit.log({ actorId: user.id, action: 'DEVICE_REGISTERED', entity: 'device', entityId: id, ip, meta: { platform: dto.platform } }, m);
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
