import { MasterController } from '@/controllers/MasterController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const GET = route({ public: true }, MasterController.complaintTypes);
