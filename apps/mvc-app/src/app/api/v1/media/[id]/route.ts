import { MediaController } from '@/controllers/MediaController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const GET = route({ roles: ['CITIZEN', 'WORKER', 'SUPERVISOR', 'SUB_ADMIN'] }, MediaController.get);
