import { GoogleAccessToken, parseServiceAccount } from '../../common/google-auth';
import { AppConfig, IntegrityLevel } from '../../config/configuration';

const SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const TIMEOUT_MS = 10_000;
/** Google recommends rejecting tokens older than a few minutes. */
export const MAX_TOKEN_AGE_MS = 10 * 60_000;

/** The decoded verdict, as returned by `v1/{package}:decodeIntegrityToken`. */
export interface IntegrityPayload {
  requestDetails?: { requestPackageName?: string; nonce?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string; packageName?: string; certificateSha256Digest?: string[] };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
  accountDetails?: { appLicensingVerdict?: string };
}

export type DeviceVerdict = 'MEETS_STRONG_INTEGRITY' | 'MEETS_DEVICE_INTEGRITY' | 'MEETS_BASIC_INTEGRITY' | 'NONE';

export class IntegrityRejected extends Error {}

const RANK: Record<DeviceVerdict, number> = { NONE: 0, MEETS_BASIC_INTEGRITY: 1, MEETS_DEVICE_INTEGRITY: 2, MEETS_STRONG_INTEGRITY: 3 };
const LEVEL: Record<IntegrityLevel, DeviceVerdict> = { BASIC: 'MEETS_BASIC_INTEGRITY', DEVICE: 'MEETS_DEVICE_INTEGRITY', STRONG: 'MEETS_STRONG_INTEGRITY' };

export function deviceVerdict(p: IntegrityPayload): DeviceVerdict {
  const labels = p.deviceIntegrity?.deviceRecognitionVerdict ?? [];
  return (['MEETS_STRONG_INTEGRITY', 'MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY'] as const).find((l) => labels.includes(l)) ?? 'NONE';
}

/**
 * Checks a decoded verdict against what this request expected. Pure, so every rule is unit tested.
 * Returns the device verdict; throws IntegrityRejected with a reason safe to log (not to show).
 */
export function checkPayload(
  p: IntegrityPayload,
  expected: { packageName: string; nonce: string; certSha256: string[]; minLevel: IntegrityLevel; now?: number },
): DeviceVerdict {
  const rd = p.requestDetails ?? {};
  if (rd.requestPackageName !== expected.packageName) throw new IntegrityRejected(`package ${rd.requestPackageName}`);
  if (rd.nonce !== expected.nonce) throw new IntegrityRejected('nonce mismatch');
  const age = (expected.now ?? Date.now()) - Number(rd.timestampMillis ?? 0);
  if (!(age >= -60_000 && age <= MAX_TOKEN_AGE_MS)) throw new IntegrityRejected('token too old');
  const app = p.appIntegrity ?? {};
  if (app.appRecognitionVerdict !== 'PLAY_RECOGNIZED') throw new IntegrityRejected(`app ${app.appRecognitionVerdict}`);
  if (app.packageName !== expected.packageName) throw new IntegrityRejected('app package mismatch');
  if (expected.certSha256.length && !(app.certificateSha256Digest ?? []).some((d) => expected.certSha256.includes(d))) {
    throw new IntegrityRejected('signing certificate');
  }
  const verdict = deviceVerdict(p);
  if (RANK[verdict] < RANK[LEVEL[expected.minLevel]]) throw new IntegrityRejected(`device ${verdict}`);
  return verdict;
}

/** Calls Google to decrypt and verify a token (the token is opaque to us). */
export class PlayIntegrityClient {
  private readonly auth: GoogleAccessToken;

  constructor(private readonly config: AppConfig['playIntegrity']) {
    this.auth = new GoogleAccessToken(parseServiceAccount(config.serviceAccountJson!, 'Play Integrity'), SCOPE);
  }

  async decode(packageName: string, token: string): Promise<IntegrityPayload> {
    const access = await this.auth.get();
    const res = await fetch(`${this.config.apiBase}/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ integrity_token: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) this.auth.invalidate();
    if (res.status === 400) throw new IntegrityRejected('token not decodable');
    if (!res.ok) throw new Error(`Play Integrity returned ${res.status}`);
    const body = (await res.json()) as { tokenPayloadExternal?: IntegrityPayload };
    return body.tokenPayloadExternal ?? {};
  }
}
