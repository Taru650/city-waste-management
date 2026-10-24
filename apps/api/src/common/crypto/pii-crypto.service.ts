import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

/**
 * Field-level protection for personal data.
 * - encrypt/decrypt: AES-256-GCM, stored as base64(iv | tag | ciphertext).
 * - blindIndex: keyed HMAC so we can look up a user by mobile/email without storing it in clear.
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
    const buf = Buffer.from(stored, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.config.piiEncryptionKey, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  }

  blindIndex(value: string): string {
    return createHmac('sha256', this.config.piiHashKey).update(value.trim().toLowerCase()).digest('hex');
  }
}
