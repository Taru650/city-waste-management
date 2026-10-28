import { AuthController } from '@/controllers/AuthController';
import { route } from '@/middleware/route';
import { logoutSchema } from '@/validation/auth';

export const dynamic = 'force-dynamic';
export const POST = route({ public: true, body: logoutSchema }, AuthController.logout);
