import { AuthController } from '@/controllers/AuthController';
import { route } from '@/middleware/route';
import { refreshSchema } from '@/validation/auth';

export const dynamic = 'force-dynamic';
export const POST = route({ public: true, throttle: 'auth', body: refreshSchema }, AuthController.refresh);
