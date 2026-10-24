import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AccessTokenClaims, AuthUser } from '../auth-user';
import { ALLOW_PENDING_PASSWORD_CHANGE, IS_PUBLIC } from '../decorators';

/**
 * Global guard. Every route requires a valid access token unless marked @Public().
 * The user row is re-read on each request so that disabling an account, resetting a
 * password or a role change takes effect immediately (token_version check).
 */
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
    if (claims.typ !== 'access' || typeof claims.sub !== 'string') throw new UnauthorizedException();

    const [row] = await this.ds.query(
      `SELECT id, role, status, token_version, must_change_password, district_id, ulb_id, area_id
         FROM users WHERE id = $1`,
      [claims.sub],
    );
    if (!row || row.status === 'DISABLED' || row.token_version !== claims.tv) throw new UnauthorizedException();

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
    req.user = user;
    return true;
  }
}
