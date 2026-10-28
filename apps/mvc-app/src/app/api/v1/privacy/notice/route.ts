import { PrivacyController } from '@/controllers/PrivacyController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const GET = route({ public: true }, PrivacyController.notice);
