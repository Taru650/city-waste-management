import { UserController } from '@/controllers/UserController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const POST = route({ roles: ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN'] }, UserController.resetPassword);
