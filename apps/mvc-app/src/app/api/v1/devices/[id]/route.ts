import { MediaController } from '@/controllers/MediaController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const DELETE = route({ roles: ['CITIZEN', 'WORKER', 'SUPERVISOR', 'SUB_ADMIN'], allowWithoutConsent: true }, MediaController.revokeDevice);
