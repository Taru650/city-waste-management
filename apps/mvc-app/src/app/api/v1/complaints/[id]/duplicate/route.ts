import { ComplaintController } from '@/controllers/ComplaintController';
import { route } from '@/middleware/route';
import { duplicateSchema } from '@/validation/complaints';

export const dynamic = 'force-dynamic';
export const POST = route({ roles: ['SUPERVISOR', 'SUB_ADMIN'], body: duplicateSchema }, ComplaintController.duplicate);
