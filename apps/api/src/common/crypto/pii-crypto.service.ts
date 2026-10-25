import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

/**
 * Field-level protection for personal data.
 * - encrypt/decrypt: AES-256-GCM, stored as base64(iv | tag | ciphertext).
 * - blindIndex: keyed HMAC so we can look up a user by mobile/email without storing it in clear.
 *
 * Key rotation: while *_PREVIOUS keys are set, values written under them are still read (GCM's auth tag
 * tells the keys apart) and found (lookups match either index); everything new uses the current keys.
 * `dist/database/rotate-pii-keys.js` moves stored values to the current keys.
 */
@Injectable()
export class PiiCryptoService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.piiEncryptionKey, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  decrypt(stored: string): string {
    return this.decryptWithKey(stored).plain;
  }

  /** Whether the value was written under the current key (false = needs re-encryption). */
  isCurrent(stored: string): boolean {
    return this.decryptWithKey(stored).current;
  }

  /** Index for writes: always the current key. */
  blindIndex(value: string): string {
    return hmac(this.config.piiHashKey, value);
  }

  /** Indexes for lookups: the current key, plus the previous one during a rotation. */
  blindIndexes(value: string): string[] {
    const prev = this.config.piiHashKeyPrevious;
    return prev ? [hmac(this.config.piiHashKey, value), hmac(prev, value)] : [hmac(this.config.piiHashKey, value)];
  }

  private decryptWithKey(stored: string): { plain: string; current: boolean } {
    try {
      return { plain: open(this.config.piiEncryptionKey, stored), current: true };
    } catch (err) {
      if (!this.config.piiEncryptionKeyPrevious) throw err;
      return { plain: open(this.config.piiEncryptionKeyPrevious, stored), current: false };
    }
  }
}

function open(key: Buffer, stored: string): string {
  const buf = Buffer.from(stored, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

function hmac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value.trim().toLowerCase()).digest('hex');
}
