import { z } from 'zod';
import { email, mobile, password, personName, uuid } from '@/lib/validators';

/**
 * How the caller wants its session delivered: "token" (apps: tokens in the response, sent back in an
 * Authorization header) or "cookie" (the website: httpOnly cookies, no token ever visible to page scripts).
 */
export const sessionMode = z.enum(['token', 'cookie']).default('token');
export type SessionMode = z.infer<typeof sessionMode>;

/** Sent by the apps with some requests; this edition accepts and ignores them (no CAPTCHA, no Play Integrity). */
export const ignored = {
  captchaToken: z.string().max(4096).optional(),
  attestationChallenge: z.string().max(300).optional(),
  integrityToken: z.string().max(8192).optional(),
  attestationError: z.string().max(100).optional(),
};

export const registerSchema = z
  .object({
    homeWardId: uuid,
    name: personName,
    guardianName: personName.optional(),
    mobile,
    email,
    password,
    consentNoticeVersion: z.string().max(20),
    consentLanguage: z.enum(['hi', 'en']).optional(),
    session: sessionMode,
    ...ignored,
  })
  .strict();

export const loginSchema = z
  .object({ identifier: z.string().trim().min(3).max(120), password, session: sessionMode, ...ignored })
  .strict();

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200).optional() }).strict();
export const logoutSchema = refreshSchema;

export const changePasswordSchema = z.object({ currentPassword: password, newPassword: password, session: sessionMode }).strict();
export const forgotPasswordSchema = z.object({ identifier: z.string().trim().min(3).max(120), ...ignored }).strict();
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), newPassword: password }).strict();
export const preferencesSchema = z.object({ preferredLanguage: z.enum(['hi', 'en']) }).strict();
