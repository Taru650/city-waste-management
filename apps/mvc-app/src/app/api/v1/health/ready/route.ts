import { HealthController } from '@/controllers/HealthController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const GET = route({ public: true }, () => HealthController.ready());
