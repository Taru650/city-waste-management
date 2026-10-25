import { createSign } from 'crypto';

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

const TIMEOUT_MS = 10_000;

export function parseServiceAccount(json: string, what: string): ServiceAccount {
  const sa = JSON.parse(json) as ServiceAccount;
  if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error(`${what} service account JSON is incomplete`);
  return { ...sa, token_uri: sa.token_uri ?? 'https://oauth2.googleapis.com/token' };
}

/**
 * Google service-account OAuth (RS256 JWT bearer grant → access token), cached until shortly
 * before expiry. No SDK: one HTTPS call per hour per scope.
 */
export class GoogleAccessToken {
  private token?: { value: string; expiresAt: number };

  constructor(readonly account: ServiceAccount, private readonly scope: string) {}

  invalidate() {
    this.token = undefined;
  }

  async get(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const sa = this.account;
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: this.scope, aud: sa.token_uri, iat: now, exp: now + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const res = await fetch(sa.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }
}
