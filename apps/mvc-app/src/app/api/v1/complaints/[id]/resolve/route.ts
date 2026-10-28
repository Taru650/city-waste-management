import { ComplaintController } from '@/controllers/ComplaintController';
import { route } from '@/middleware/route';
import { resolveSchema } from '@/validation/complaints';

export const dynamic = 'force-dynamic';
export const POST = route({ roles: ['WORKER', 'SUPERVISOR', 'SUB_ADMIN'], body: resolveSchema }, ComplaintController.resolve);
