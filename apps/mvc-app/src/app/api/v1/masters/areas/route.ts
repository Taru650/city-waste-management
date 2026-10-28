import { MasterController } from '@/controllers/MasterController';
import { route } from '@/middleware/route';
import { createAreaSchema } from '@/validation/masters';

export const dynamic = 'force-dynamic';
export const POST = route({ roles: ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN'], body: createAreaSchema }, MasterController.createArea);
