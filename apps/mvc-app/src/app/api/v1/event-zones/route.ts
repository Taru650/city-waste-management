import { ZoneController } from '@/controllers/ZoneController';
import { route } from '@/middleware/route';
import { createZoneSchema, listZonesQuery } from '@/validation/zones';

export const dynamic = 'force-dynamic';
const MANAGERS = ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN'] as const;
export const GET = route({ roles: [...MANAGERS, 'SUPERVISOR'], query: listZonesQuery }, ZoneController.list);
export const POST = route({ roles: [...MANAGERS], body: createZoneSchema }, ZoneController.create);
