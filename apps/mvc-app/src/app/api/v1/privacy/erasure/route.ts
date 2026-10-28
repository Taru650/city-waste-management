import { PrivacyController } from '@/controllers/PrivacyController';
import { route } from '@/middleware/route';
import { erasureSchema } from '@/validation/privacy';

export const dynamic = 'force-dynamic';
export const POST = route({ roles: ['CITIZEN'], allowWithoutConsent: true, throttle: 'auth', body: erasureSchema }, PrivacyController.erase);
