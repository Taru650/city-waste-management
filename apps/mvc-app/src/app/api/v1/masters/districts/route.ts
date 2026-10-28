import { MasterController } from '@/controllers/MasterController';
import { route } from '@/middleware/route';
import { createDistrictSchema } from '@/validation/masters';

export const dynamic = 'force-dynamic';
export const GET = route({ public: true }, MasterController.districts);
export const POST = route({ roles: ['WEB_ADMIN'], body: createDistrictSchema }, MasterController.createDistrict);
