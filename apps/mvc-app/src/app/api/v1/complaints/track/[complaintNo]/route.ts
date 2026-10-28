import { ComplaintController } from '@/controllers/ComplaintController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const GET = route({}, ComplaintController.track);
