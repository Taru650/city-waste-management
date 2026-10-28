import { SignJWT } from 'jose';
import { getConfig } from '@/config/env';
import { db } from '@/db/connection';
import type { Db } from '@/db/sql';
import { newOpaqueToken, sha256 } from '@/lib/crypto';
import { unauthorized } from '@/lib/errors';
import { newId } from '@/lib/ids';
import type { Role } from '@/lib/enums';
import type { ClientInfo } from '@/middleware/http';
import { SessionModel } from '@/models/SessionModel';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** How long the refresh token (the session) lasts, in seconds. */
  refreshExpiresIn: number;
  tokenType: 'Bearer';
}

interface SessionUser {
  id: string;
  role: Role;
  token_version: number;
}

/**
 * Login sessions: a short-lived access token (JWT) plus a single-use refresh token that rotates on every
 * refresh. A refresh token that is used twice means it was stolen, so the whole session ("family") is revoked.
 * Each access token carries its session id, so signing out also ends the access tokens of that session.
 */
export const SessionService = {
  async issue(d: Db, user: SessionUser, client: ClientInfo, familyId: string = newId()): Promise<SessionTokens> {
    const c = getConfig();
    const accessToken = await new SignJWT({ role: user.role, tv: user.token_version, sid: familyId, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${c.accessTokenTtlSeconds}s`)
      .sign(c.jwtAccessSecret);
    const refreshToken = newOpaqueToken();
    const days = user.role === 'CITIZEN' ? c.refreshTtlDaysCitizen : c.refreshTtlDaysStaff;
    await SessionModel.insertRefresh(d, {
      id: newId(),
      userId: user.id,
      familyId,
      tokenHash: sha256(refreshToken),
      days,
      ip: client.ip,
      userAgent: client.userAgent,
    });
    return { accessToken, refreshToken, expiresIn: c.accessTokenTtlSeconds, refreshExpiresIn: days * 86_400, tokenType: 'Bearer' };
  },

  async rotate(refreshToken: string, client: ClientInfo): Promise<SessionTokens> {
    const result = await db().transaction(async (trx): Promise<SessionTokens | 'REJECT'> => {
      const row = await SessionModel.findForRotation(trx, sha256(refreshToken));
      if (!row) return 'REJECT';
      if (row.used_at || row.revoked_at) {
        // Reuse of a rotated token: treat as theft and end every session in this family.
        // Returned (not thrown) so the revocation commits instead of rolling back.
        await SessionModel.revokeFamily(trx, row.family_id);
        return 'REJECT';
      }
      if (row.expired || row.status === 'DISABLED' || row.access_expired) return 'REJECT';
      await SessionModel.markUsed(trx, row.id);
      return this.issue(trx, { id: row.user_id, role: row.role, token_version: row.token_version }, client, row.family_id);
    });
    if (result === 'REJECT') throw unauthorized();
    return result;
  },

  /** Sign out of this device. Unknown tokens are ignored (same answer either way). */
  async logout(refreshToken: string): Promise<void> {
    await SessionModel.revokeFamilyOfToken(db(), sha256(refreshToken));
  },

  /** Sign out of every device and end every live access token. */
  revokeEverything(d: Db, userId: string) {
    return SessionModel.revokeEverything(d, userId);
  },
};
