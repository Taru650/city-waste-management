import { PrivacyController } from '@/controllers/PrivacyController';
import { route } from '@/middleware/route';
import { consentSchema } from '@/validation/privacy';

export const dynamic = 'force-dynamic';
export const POST = route({ roles: ['CITIZEN'], allowWithoutConsent: true, body: consentSchema }, PrivacyController.consent);
