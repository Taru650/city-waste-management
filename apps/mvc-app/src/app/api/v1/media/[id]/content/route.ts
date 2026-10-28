import { MediaController } from '@/controllers/MediaController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
// The body is the raw photo or video, read (and size-checked) by the service.
export const PUT = route({ roles: ['CITIZEN', 'WORKER', 'SUPERVISOR', 'SUB_ADMIN'], rawBody: true }, MediaController.upload);
