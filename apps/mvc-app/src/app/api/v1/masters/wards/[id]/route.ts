import { MasterController } from '@/controllers/MasterController';
import { route } from '@/middleware/route';
import { updateWardSchema } from '@/validation/masters';

export const dynamic = 'force-dynamic';
export const PATCH = route({ roles: ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN'], body: updateWardSchema }, MasterController.updateWard);
