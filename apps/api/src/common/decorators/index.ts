import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '../enums';
import { AuthUser } from '../auth-user';

export const IS_PUBLIC = 'isPublic';
/** Route needs no access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const ALLOW_PENDING_PASSWORD_CHANGE = 'allowPendingPasswordChange';
/** Route stays reachable while the user still has to replace a temporary password. */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE, true);

export const ALLOW_WITHOUT_CONSENT = 'allowWithoutConsent';
/**
 * Route stays reachable for a citizen who has not consented to the current privacy notice (DPDP):
 * account and session management, the privacy rights themselves (notice, consent, export,
 * correction, erasure) and device security. Everything else answers 403 CONSENT_REQUIRED.
 */
export const AllowWithoutConsent = () => SetMetadata(ALLOW_WITHOUT_CONSENT, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
