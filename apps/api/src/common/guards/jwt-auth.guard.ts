import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AccessTokenClaims, AuthUser } from '../auth-user';
import { NOTICE_VERSION, PURPOSE } from '../../modules/privacy/notice';
import { ALLOW_PENDING_PASSWORD_CHANGE, ALLOW_WITHOUT_CONSENT, IS_PUBLIC } from '../decorators';

/**
 * Global guard. Every route requires a valid access token unless marked @Public().
 * The user row is re-read on each request so that disabling an account, resetting a
 * password or a role change takes effect immediately (token_version check), and signing out
 * ends the session for its access tokens too, not only for the refresh token (sid check).
 * The same query tells whether a citizen has consented to the current privacy notice
 * (no extra round trip).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(header.slice(7), {
        secret: this.config.jwtAccessSecret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException();
    }
    if (claims.typ !== 'access' || typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || !UUID.test(claims.sid)) {
      throw new UnauthorizedException();
    }

    const [row] = await this.ds.query(
      `SELECT id, role, status, token_version, must_change_password, district_id, ulb_id, area_id,
              (access_expires_at IS NOT NULL AND access_expires_at <= now()) AS access_expired,
              EXISTS (SELECT 1 FROM refresh_tokens rt WHERE rt.family_id = $4 AND rt.user_id = users.id AND rt.revoked_at IS NULL) AS session_live,
              (role = 'CITIZEN' AND NOT EXISTS (
                 SELECT 1 FROM consents k WHERE k.user_id = users.id AND k.purpose = $2 AND k.notice_version = $3 AND k.withdrawn_at IS NULL
              )) AS consent_required
         FROM users WHERE id = $1`,
      [claims.sub, PURPOSE, NOTICE_VERSION, claims.sid],
    );
    // Temporary (event) staff lose access the moment it expires, including sessions already open.
    if (!row || row.status === 'DISABLED' || row.access_expired || row.token_version !== claims.tv || !row.session_live) {
      throw new UnauthorizedException();
    }

    const user: AuthUser = {
      id: row.id,
      role: row.role,
      districtId: row.district_id,
      ulbId: row.ulb_id,
      areaId: row.area_id,
      mustChangePassword: row.must_change_password,
    };
    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_CHANGE, targets)) {
      throw new ForbiddenException('Password change required');
    }
    if (row.consent_required && !this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_CONSENT, targets)) {
      throw new ForbiddenException({ statusCode: 403, code: 'CONSENT_REQUIRED', message: 'Please read and accept the current privacy notice' });
    }
    req.user = user;
    return true;
  }
}
