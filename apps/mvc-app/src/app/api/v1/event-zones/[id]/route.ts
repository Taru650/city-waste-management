import { ZoneController } from '@/controllers/ZoneController';
import { route } from '@/middleware/route';
import { updateZoneSchema } from '@/validation/zones';

export const dynamic = 'force-dynamic';
const MANAGERS = ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN'] as const;
export const GET = route({ roles: [...MANAGERS, 'SUPERVISOR'] }, ZoneController.get);
export const PATCH = route({ roles: [...MANAGERS], body: updateZoneSchema }, ZoneController.update);
