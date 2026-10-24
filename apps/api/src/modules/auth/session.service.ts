import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AccessTokenClaims } from '../../common/auth-user';
import { Role } from '../../common/enums';
import { newOpaqueToken, sha256 } from '../../common/crypto/tokens';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

/**
 * Access tokens: short-lived HS256 JWT bound to users.token_version.
 * Refresh tokens: opaque, single-use, rotated on every refresh. Presenting an
 * already-used token means it was stolen, so the whole family is revoked.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly ds: DataSource,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async issue(
    user: { id: string; role: Role; token_version: number },
    client: ClientInfo,
    familyId: string = randomUUID(),
    manager: EntityManager = this.ds.manager,
  ): Promise<SessionTokens> {
    const claims: AccessTokenClaims = { sub: user.id, role: user.role, tv: user.token_version, typ: 'access' };
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.jwtAccessSecret,
      algorithm: 'HS256',
      expiresIn: this.config.accessTokenTtlSeconds,
    });
    const refreshToken = newOpaqueToken();
    const days = user.role === Role.CITIZEN ? this.config.refreshTtlDaysCitizen : this.config.refreshTtlDaysStaff;
    await manager.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6)`,
      [user.id, familyId, sha256(refreshToken), days, client.ip?.slice(0, 64) ?? null, client.userAgent?.slice(0, 255) ?? null],
    );
    return { accessToken, refreshToken, expiresIn: this.config.accessTokenTtlSeconds, tokenType: 'Bearer' };
  }

  async rotate(refreshToken: string, client: ClientInfo): Promise<SessionTokens> {
    const result = await this.ds.transaction(async (m): Promise<SessionTokens | 'REJECT'> => {
      const [row] = await m.query(
        `SELECT rt.id, rt.family_id, rt.used_at, rt.revoked_at, rt.expires_at < now() AS expired,
                u.id AS user_id, u.role, u.status, u.token_version
           FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = $1
          FOR UPDATE OF rt`,
        [sha256(refreshToken)],
      );
      if (!row) return 'REJECT';
      if (row.used_at || row.revoked_at) {
        // Reuse of a rotated token: treat as theft and kill every session in this family.
        // Returned (not thrown) so the revocation commits instead of being rolled back.
        await m.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [row.family_id]);
        return 'REJECT';
      }
      if (row.expired || row.status === 'DISABLED') return 'REJECT';
      await m.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [row.id]);
      return this.issue({ id: row.user_id, role: row.role, token_version: row.token_version }, client, row.family_id, m);
    });
    if (result === 'REJECT') throw new UnauthorizedException();
    return result;
  }

  /** Revoke the family the given refresh token belongs to (logout on one device). */
  async revokeFamily(refreshToken: string): Promise<void> {
    await this.ds.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE revoked_at IS NULL
          AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [sha256(refreshToken)],
    );
  }

  /** Log the user out everywhere: revoke all refresh tokens and invalidate live access tokens. */
  async revokeAll(userId: string, manager: EntityManager = this.ds.manager): Promise<void> {
    await manager.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    // Device signing keys go too; the app re-registers its key after the next login.
    await manager.query(`UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    // ...and push tokens, so a signed-out phone stops receiving this user's notifications.
    await manager.query(`DELETE FROM push_tokens WHERE user_id = $1`, [userId]);
    await manager.query(`UPDATE users SET token_version = token_version + 1, updated_at = now() WHERE id = $1`, [userId]);
  }
}
