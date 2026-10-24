import { createHash, createPublicKey, KeyObject, verify } from 'crypto';

/**
 * What the app signs at the moment of capture. The app sends the exact signed bytes
 * (base64url JSON) so there is no canonicalisation to get wrong between Dart and Node.
 * Binding mediaId and sha256 makes a signature usable for exactly one upload of one file.
 */
export interface CaptureManifest {
  v: 1;
  mediaId: string;
  deviceId: string;
  kind: 'PHOTO' | 'VIDEO';
  sha256: string;
  capturedAt: string;
  lat: number;
  lng: number;
  accuracyM: number;
  isMockLocation: boolean;
}

export class ManifestError extends Error {}

/** Accept only EC P-256 public keys (what Android Keystore / Secure Enclave generate), SPKI DER base64. */
export function parseDevicePublicKey(spkiBase64: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new ManifestError('publicKey must be a DER/SPKI encoded public key');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new ManifestError('publicKey must be an EC P-256 key');
  }
  return key;
}

export function keyFingerprint(spkiBase64: string): string {
  return createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex');
}

/** Verifies the ECDSA-SHA256 (DER) signature over the raw manifest bytes and validates its shape. */
export function verifyManifest(manifestB64: string, signatureB64: string, publicKey: KeyObject): CaptureManifest {
  const raw = Buffer.from(manifestB64, 'base64url');
  let ok = false;
  try {
    ok = verify('sha256', raw, { key: publicKey, dsaEncoding: 'der' }, Buffer.from(signatureB64, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) throw new ManifestError('Capture signature is invalid');

  let m: CaptureManifest;
  try {
    m = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ManifestError('Manifest is not valid JSON');
  }
  const valid =
    m && m.v === 1 &&
    typeof m.mediaId === 'string' && typeof m.deviceId === 'string' &&
    (m.kind === 'PHOTO' || m.kind === 'VIDEO') &&
    typeof m.sha256 === 'string' && /^[a-f0-9]{64}$/.test(m.sha256) &&
    typeof m.capturedAt === 'string' && !Number.isNaN(Date.parse(m.capturedAt)) &&
    typeof m.lat === 'number' && Math.abs(m.lat) <= 90 &&
    typeof m.lng === 'number' && Math.abs(m.lng) <= 180 &&
    typeof m.accuracyM === 'number' && m.accuracyM >= 0 &&
    typeof m.isMockLocation === 'boolean';
  if (!valid) throw new ManifestError('Manifest fields are missing or invalid');
  return m;
}
