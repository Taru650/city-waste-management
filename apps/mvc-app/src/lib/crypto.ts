import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { getConfig } from '@/config/env';

/**
 * Field-level protection for personal data (mobile number, email).
 * - encrypt/decrypt: AES-256-GCM, stored as base64(iv | tag | ciphertext).
 * - blindIndex: keyed HMAC, so a user can be found by mobile/email without storing either in clear.
 */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getConfig().piiEncryptionKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(stored: string): string {
  const buf = Buffer.from(stored, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', getConfig().piiEncryptionKey, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function blindIndex(value: string): string {
  return createHmac('sha256', getConfig().piiHashKey).update(value.trim().toLowerCase()).digest('hex');
}

/** Opaque, URL-safe random token (refresh and password-reset tokens). */
export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored only as SHA-256 hashes, so a database leak does not leak live tokens. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
