import { MasterController } from '@/controllers/MasterController';
import { route } from '@/middleware/route';
import { createUlbSchema } from '@/validation/masters';

export const dynamic = 'force-dynamic';
export const POST = route({ roles: ['WEB_ADMIN', 'DISTRICT_ADMIN'], body: createUlbSchema }, MasterController.createUlb);
