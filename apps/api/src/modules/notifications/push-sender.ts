import { Inject, Injectable, Logger } from '@nestjs/common';
import { GoogleAccessToken, parseServiceAccount, ServiceAccount } from '../../common/google-auth';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

/** UNREGISTERED: drop the token. FAILED: permanent for this message (e.g. 400), token kept. */
export type PushResult = 'OK' | 'UNREGISTERED' | 'FAILED' | 'RETRY' | 'SKIPPED';

export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 10_000;

/**
 * Firebase Cloud Messaging HTTP v1. Authenticates with a service account (see GoogleAccessToken). No SDK: two HTTPS calls.
 */
@Injectable()
export class PushSender {
  private readonly logger = new Logger('Push');
  private readonly account?: ServiceAccount;
  private readonly auth?: GoogleAccessToken;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.fcm.serviceAccountJson) {
      this.account = parseServiceAccount(config.fcm.serviceAccountJson, 'FCM');
      this.auth = new GoogleAccessToken(this.account, FCM_SCOPE);
    }
  }

  get enabled(): boolean {
    return !!this.account;
  }

  async send(deviceToken: string, msg: PushMessage): Promise<PushResult> {
    if (!this.account) return 'SKIPPED';
    let access: string;
    try {
      access = await this.auth!.get();
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
      if (res.status === 401) this.auth!.invalidate();
      if (res.status === 400 || res.status === 403) return 'FAILED';
      return 'RETRY';
    } catch (err) {
      this.logger.warn(`FCM send failed: ${err}`);
      return 'RETRY';
    }
  }
}
