import { UserController } from '@/controllers/UserController';
import { route } from '@/middleware/route';
import { createStaffSchema, listUsersQuery } from '@/validation/users';

export const dynamic = 'force-dynamic';
export const GET = route({ roles: ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN'], query: listUsersQuery }, UserController.list);
export const POST = route({ roles: ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN'], body: createStaffSchema }, UserController.create);
