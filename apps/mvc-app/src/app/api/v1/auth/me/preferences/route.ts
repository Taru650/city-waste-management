import { AuthController } from '@/controllers/AuthController';
import { route } from '@/middleware/route';
import { preferencesSchema } from '@/validation/auth';

export const dynamic = 'force-dynamic';
export const PATCH = route(
  { allowPendingPasswordChange: true, allowWithoutConsent: true, body: preferencesSchema },
  AuthController.setPreferences,
);
