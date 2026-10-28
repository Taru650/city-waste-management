import { MasterController } from '@/controllers/MasterController';
import { route } from '@/middleware/route';
import { locateQuery } from '@/validation/masters';

export const dynamic = 'force-dynamic';
export const GET = route({ query: locateQuery }, MasterController.locate);
