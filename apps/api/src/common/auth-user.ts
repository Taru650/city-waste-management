import { Role } from './enums';

/** The authenticated caller, loaded fresh from the DB on every request. */
export interface AuthUser {
  id: string;
  role: Role;
  districtId: string | null;
  ulbId: string | null;
  areaId: string | null;
  mustChangePassword: boolean;
}

export interface AccessTokenClaims {
  sub: string;
  role: Role;
  tv: number;
  /** Session (refresh-token family) the token was issued for; revoking the session revokes the token. */
  sid: string;
  typ: 'access';
}

export interface MfaTokenClaims {
  sub: string;
  typ: 'mfa';
  /** 'verify' = enrolled, needs a code; 'enroll' = must set up TOTP first. */
  stage: 'verify' | 'enroll';
}
