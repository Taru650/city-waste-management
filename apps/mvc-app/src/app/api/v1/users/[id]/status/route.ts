import { UserController } from '@/controllers/UserController';
import { route } from '@/middleware/route';
import { updateStatusSchema } from '@/validation/users';

export const dynamic = 'force-dynamic';
export const PATCH = route({ roles: ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN'], body: updateStatusSchema }, UserController.setStatus);
