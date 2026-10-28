import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConfig } from '@/config/env';

/** Links to photos and videos stay valid for 5 minutes and are tied to one file and one variant. */
export const FILE_URL_TTL_SECONDS = 300;
export type Variant = 'main' | 'thumb';

function sign(id: string, variant: Variant, exp: number): string {
  // A key derived from the JWT secret (so it needs no extra setting) but not usable as a JWT key.
  const key = createHmac('sha256', getConfig().jwtAccessSecret).update('media-file-url').digest();
  return createHmac('sha256', key).update(`${id}.${variant}.${exp}`).digest('hex');
}

export function signedFileUrl(origin: string, id: string, variant: Variant): string {
  const exp = Math.floor(Date.now() / 1000) + FILE_URL_TTL_SECONDS;
  return `${origin}/api/v1/media/${id}/file?v=${variant}&exp=${exp}&sig=${sign(id, variant, exp)}`;
}

export function verifyFileUrl(id: string, variant: string, exp: string, sig: string): boolean {
  if (variant !== 'main' && variant !== 'thumb') return false;
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(sign(id, variant, e), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
