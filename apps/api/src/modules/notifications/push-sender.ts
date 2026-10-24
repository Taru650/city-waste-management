import { Inject, Injectable, Logger } from '@nestjs/common';
import { createSign } from 'crypto';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

/** UNREGISTERED: drop the token. FAILED: permanent for this message (e.g. 400), token kept. */
export type PushResult = 'OK' | 'UNREGISTERED' | 'FAILED' | 'RETRY' | 'SKIPPED';

export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 10_000;

/**
 * Firebase Cloud Messaging HTTP v1. Authenticates with a service account (RS256 JWT →
 * OAuth access token, cached until shortly before expiry). No SDK: two HTTPS calls.
 */
@Injectable()
export class PushSender {
  private readonly logger = new Logger('Push');
  private readonly account?: ServiceAccount;
  private token?: { value: string; expiresAt: number };

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.fcm.serviceAccountJson) {
      const sa = JSON.parse(config.fcm.serviceAccountJson) as ServiceAccount;
      if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error('FCM service account JSON is incomplete');
      this.account = { ...sa, token_uri: sa.token_uri ?? 'https://oauth2.googleapis.com/token' };
    }
  }

  get enabled(): boolean {
    return !!this.account;
  }

  async send(deviceToken: string, msg: PushMessage): Promise<PushResult> {
    if (!this.account) return 'SKIPPED';
    let access: string;
    try {
      access = await this.accessToken();
    } catch (err) {
      this.logger.warn(`FCM auth failed: ${err}`);
      return 'RETRY';
    }
    try {
      const res = await fetch(`${this.config.fcm.apiBase}/v1/projects/${this.account.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: msg.title, body: msg.body },
            data: msg.data,
            android: { priority: 'HIGH' },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return 'OK';
      const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } };
      const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status;
      if (res.status === 404 || code === 'UNREGISTERED') return 'UNREGISTERED';
      if (res.status === 401) this.token = undefined;
      if (res.status === 400 || res.status === 403) return 'FAILED';
      return 'RETRY';
    } catch (err) {
      this.logger.warn(`FCM send failed: ${err}`);
      return 'RETRY';
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const sa = this.account!;
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: FCM_SCOPE, aud: sa.token_uri, iat: now, exp: now + 3600 })}`;
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
