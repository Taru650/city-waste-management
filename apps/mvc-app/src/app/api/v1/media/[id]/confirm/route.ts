import { MediaController } from '@/controllers/MediaController';
import { route } from '@/middleware/route';
import { confirmUploadSchema } from '@/validation/media';

export const dynamic = 'force-dynamic';
export const POST = route({ roles: ['CITIZEN', 'WORKER', 'SUPERVISOR', 'SUB_ADMIN'], body: confirmUploadSchema }, MediaController.confirm);
