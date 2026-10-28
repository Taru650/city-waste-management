import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConfig } from '@/config/env';

/** Links to photos and videos stay valid for 5 minutes and are tied to one file and one variant. */
export const FILE_URL_TTL_SECONDS = 300;
export type Variant = 'main' | 'thumb';

/** Keys derived from the JWT secret (so they need no extra setting) but not usable as JWT keys, one per purpose. */
function sign(purpose: 'media-file-url' | 'media-upload-url', message: string): string {
  const key = createHmac('sha256', getConfig().jwtAccessSecret).update(purpose).digest();
  return createHmac('sha256', key).update(message).digest('hex');
}

function sameSignature(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = /^[0-9a-f]+$/i.test(given) ? Buffer.from(given, 'hex') : Buffer.alloc(0);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signedFileUrl(origin: string, id: string, variant: Variant): string {
  const exp = Math.floor(Date.now() / 1000) + FILE_URL_TTL_SECONDS;
  return `${origin}/api/v1/media/${id}/file?v=${variant}&exp=${exp}&sig=${sign('media-file-url', `${id}.${variant}.${exp}`)}`;
}

export function verifyFileUrl(id: string, variant: string, exp: string, sig: string): boolean {
  if (variant !== 'main' && variant !== 'thumb') return false;
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Math.floor(Date.now() / 1000)) return false;
  return sameSignature(sign('media-file-url', `${id}.${variant}.${e}`), sig);
}

/**
 * Where an app sends the bytes of one declared photo or video: like a storage "presigned URL", the address itself is
 * the credential. It is tied to one declared upload and stops working after `ttlSeconds`. (What the file may contain
 * is still enforced: exact type and size, and at confirm time the signed capture manifest and the checksum.)
 */
export function signedUploadUrl(origin: string, id: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${origin}/api/v1/media/${id}/content?exp=${exp}&sig=${sign('media-upload-url', `${id}.${exp}`)}`;
}

export function verifyUploadUrl(id: string, exp: string | null, sig: string | null): boolean {
  const e = Number(exp);
  if (!exp || !sig || !Number.isInteger(e) || e < Math.floor(Date.now() / 1000)) return false;
  return sameSignature(sign('media-upload-url', `${id}.${e}`), sig);
}
