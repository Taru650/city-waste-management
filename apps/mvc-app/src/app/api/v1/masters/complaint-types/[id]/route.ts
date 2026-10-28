import { MasterController } from '@/controllers/MasterController';
import { route } from '@/middleware/route';
import { updateComplaintTypeSchema } from '@/validation/masters';

export const dynamic = 'force-dynamic';
export const PATCH = route({ roles: ['WEB_ADMIN'], body: updateComplaintTypeSchema }, MasterController.updateComplaintType);
