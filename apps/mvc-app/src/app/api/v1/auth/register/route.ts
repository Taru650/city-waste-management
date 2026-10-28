import { AuthController } from '@/controllers/AuthController';
import { route } from '@/middleware/route';
import { registerSchema } from '@/validation/auth';

export const dynamic = 'force-dynamic';
export const POST = route({ public: true, throttle: 'auth', body: registerSchema }, AuthController.register);
