import { jwtVerify } from 'jose';
import { getConfig } from '@/config/env';
import { db } from '@/db/connection';
import { one } from '@/db/sql';
import { CONSENT_PURPOSE, NOTICE_VERSION } from '@/lib/notice';
import { isUuid } from '@/lib/ids';
import type { Role } from '@/lib/enums';
import { COOKIES, parseCookies } from './http';

/** The authenticated caller, loaded fresh from the database on every request. */
export interface AuthUser {
  id: string;
  role: Role;
  districtId: string | null;
  ulbId: string | null;
  areaId: string | null;
  mustChangePassword: boolean;
  consentRequired: boolean;
  /** The login session (refresh-token family) this access token belongs to. */
  sessionId: string;
  /** cookie = a browser session (needs CSRF protection); bearer = an app sending its own header. */
  via: 'cookie' | 'bearer';
}

export interface AccessClaims {
  sub: string;
  role: Role;
  tv: number;
  sid: string;
  typ: 'access';
}

function tokenFrom(req: Request): { token: string; via: 'cookie' | 'bearer' } | null {
  const header = req.headers.get('authorization');
  if (header) {
    if (!header.startsWith('Bearer ')) return null;
    return { token: header.slice(7), via: 'bearer' };
  }
  const cookie = parseCookies(req.headers.get('cookie'))[COOKIES.access];
  return cookie ? { token: cookie, via: 'cookie' } : null;
}

/**
 * Valid signed token, AND the user still exists and is active, AND the token's version and session are
 * still current. So disabling an account, changing a password, a role change or signing out takes effect
 * on the very next request, not when the token expires.
 */
export async function authenticate(req: Request): Promise<AuthUser | null> {
  const found = tokenFrom(req);
  if (!found) return null;
  let claims: AccessClaims;
  try {
    const { payload } = await jwtVerify(found.token, getConfig().jwtAccessSecret, { algorithms: ['HS256'] });
    claims = payload as unknown as AccessClaims;
  } catch {
    return null;
  }
  if (claims.typ !== 'access' || typeof claims.sub !== 'string' || !isUuid(claims.sid)) return null;

  const row = await one<Record<string, unknown>>(
    db(),
    `SELECT u.id, u.role, u.status, u.token_version, u.must_change_password, u.district_id, u.ulb_id, u.area_id,
            (u.access_expires_at IS NOT NULL AND u.access_expires_at <= NOW(3)) AS access_expired,
            EXISTS (SELECT 1 FROM refresh_tokens rt WHERE rt.family_id = ? AND rt.user_id = u.id AND rt.revoked_at IS NULL) AS session_live,
            (u.role = 'CITIZEN' AND NOT EXISTS (
               SELECT 1 FROM consents k WHERE k.user_id = u.id AND k.purpose = ? AND k.notice_version = ? AND k.withdrawn_at IS NULL
            )) AS consent_required
       FROM users u WHERE u.id = ?`,
    [claims.sid, CONSENT_PURPOSE, NOTICE_VERSION, claims.sub],
  );
  if (!row || row.status === 'DISABLED' || row.access_expired || row.token_version !== claims.tv || !row.session_live) return null;
  return {
    id: row.id as string,
    role: row.role as Role,
    districtId: (row.district_id as string) ?? null,
    ulbId: (row.ulb_id as string) ?? null,
    areaId: (row.area_id as string) ?? null,
    mustChangePassword: !!row.must_change_password,
    consentRequired: !!row.consent_required,
    sessionId: claims.sid,
    via: found.via,
  };
}
