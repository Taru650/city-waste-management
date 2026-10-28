import { UserController } from '@/controllers/UserController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const GET = route({ roles: ['SUB_ADMIN', 'SUPERVISOR'] }, UserController.workers);
