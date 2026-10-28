import { createHash, randomBytes } from 'crypto';

/** Opaque, URL-safe random token (refresh and password-reset tokens). */
export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored only as SHA-256 hashes, so a DB leak does not leak live tokens. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
