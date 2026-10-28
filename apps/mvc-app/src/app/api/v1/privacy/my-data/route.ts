import { PrivacyController } from '@/controllers/PrivacyController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const GET = route({ roles: ['CITIZEN'], allowWithoutConsent: true, throttle: 'auth' }, PrivacyController.myData);
