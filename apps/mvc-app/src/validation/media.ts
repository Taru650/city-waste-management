import { z } from 'zod';
import { ignored } from './auth';
import { uuid } from '@/lib/validators';

export const MEDIA_KINDS = ['PHOTO', 'VIDEO'] as const;
export type MediaKindName = (typeof MEDIA_KINDS)[number];

export const ALLOWED_TYPES: Record<MediaKindName, string[]> = {
  PHOTO: ['image/jpeg', 'image/webp'],
  VIDEO: ['video/mp4'],
};
export const MAX_BYTES: Record<MediaKindName, number> = { PHOTO: 8 * 1024 * 1024, VIDEO: 60 * 1024 * 1024 };

const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const registerDeviceSchema = z
  .object({
    /** EC P-256 public key, DER/SPKI, base64. The private key stays in Android Keystore / Secure Enclave. */
    publicKey: z.string().max(1024).regex(base64, 'must be base64'),
    platform: z.enum(['ANDROID', 'IOS']),
    appVersion: z.string().max(30).optional(),
    ...ignored,
  })
  .strict();

export const createUploadSchema = z
  .object({
    deviceId: uuid,
    kind: z.enum(MEDIA_KINDS),
    contentType: z.enum([...ALLOWED_TYPES.PHOTO, ...ALLOWED_TYPES.VIDEO] as [string, ...string[]]),
    /** Exact byte size of the compressed file. */
    bytes: z.number().int().min(1).max(MAX_BYTES.VIDEO),
    /** Hex SHA-256 of the file. */
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const confirmUploadSchema = z
  .object({
    /** base64url of the exact JSON capture manifest that was signed. */
    manifest: z.string().max(4096).regex(/^[A-Za-z0-9_-]+$/),
    /** base64 DER ECDSA-SHA256 signature over the manifest bytes. */
    signature: z.string().max(512).regex(base64, 'must be base64'),
  })
  .strict();
