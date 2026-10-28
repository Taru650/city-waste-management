import { PrivacyController } from '@/controllers/PrivacyController';
import { route } from '@/middleware/route';
import { correctProfileSchema } from '@/validation/privacy';

export const dynamic = 'force-dynamic';
export const PATCH = route({ roles: ['CITIZEN'], allowWithoutConsent: true, body: correctProfileSchema }, PrivacyController.correct);
