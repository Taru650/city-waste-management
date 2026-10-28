import type { z } from 'zod';
import type { Ctx } from '@/middleware/route';
import type { attestationChallengeSchema } from '@/validation/auth';

/**
 * The mobile apps ask for an attestation challenge before sign-up, password reset and device registration.
 * This edition does not use Google Play Integrity, so the answer is always "not enabled" and the apps carry on
 * without it (the verified NestJS API answers the same way when attestation is switched off).
 */
export const AttestationController = {
  challenge(_: Ctx<z.infer<typeof attestationChallengeSchema>, undefined, Record<string, string>>) {
    return { enabled: false };
  },
};
