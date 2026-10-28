import { MediaController } from '@/controllers/MediaController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
// Public on purpose: the short-lived signed link in the query string is the authorisation (images in <img> and in apps).
export const GET = route({ public: true }, MediaController.file);
