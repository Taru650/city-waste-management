import { getConfig } from '@/config/env';
import { GoogleAccessToken, parseServiceAccount, type ServiceAccount } from './googleAuth';

/** UNREGISTERED: drop the token. FAILED: permanent for this message (e.g. 400), token kept. */
export type PushResult = 'OK' | 'UNREGISTERED' | 'FAILED' | 'RETRY' | 'SKIPPED';

export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface PushSender {
  readonly enabled: boolean;
  send(deviceToken: string, msg: PushMessage): Promise<PushResult>;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 10_000;

/** Firebase Cloud Messaging HTTP v1, authenticated with a service account. No SDK: two HTTPS calls. */
export class FcmSender implements PushSender {
  private readonly auth: GoogleAccessToken;
  private readonly account: ServiceAccount;

  constructor(serviceAccountJson: string, private readonly apiBase: string) {
    this.account = parseServiceAccount(serviceAccountJson, 'FCM');
    this.auth = new GoogleAccessToken(this.account, FCM_SCOPE);
  }

  readonly enabled = true;

  async send(deviceToken: string, msg: PushMessage): Promise<PushResult> {
    let access: string;
    try {
      access = await this.auth.get();
    } catch (err) {
      console.warn(`[push] FCM auth failed: ${err}`);
      return 'RETRY';
    }
    try {
      const res = await fetch(`${this.apiBase}/v1/projects/${this.account.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token: deviceToken, notification: { title: msg.title, body: msg.body }, data: msg.data, android: { priority: 'HIGH' } } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return 'OK';
      const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } };
      const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status;
      if (res.status === 404 || code === 'UNREGISTERED') return 'UNREGISTERED';
      if (res.status === 401) this.auth.invalidate();
      if (res.status === 400 || res.status === 403) return 'FAILED';
      return 'RETRY';
    } catch (err) {
      console.warn(`[push] FCM send failed: ${err}`);
      return 'RETRY';
    }
  }
}

const disabled: PushSender = { enabled: false, send: async () => 'SKIPPED' };
let override: PushSender | undefined;
let cached: PushSender | undefined;

/** Tests inject a fake sender; pass undefined to go back to the configured one. */
export function setPushSender(s: PushSender | undefined) {
  override = s;
  cached = undefined;
}

/** FCM when FCM_SERVICE_ACCOUNT_JSON is set, otherwise push is off and notifications stay in-app only. */
export function getPushSender(): PushSender {
  if (override) return override;
  if (!cached) {
    const { fcm } = getConfig();
    cached = fcm.serviceAccountJson ? new FcmSender(fcm.serviceAccountJson, fcm.apiBase) : disabled;
  }
  return cached;
}
