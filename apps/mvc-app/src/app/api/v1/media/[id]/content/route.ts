import { MediaController } from '@/controllers/MediaController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
// The body is the raw photo or video, read (and size-checked) by the service. The signed address is the credential
// (as with a storage presigned URL), so no login is needed here; the confirm step that follows needs one.
export const PUT = route({ public: true, rawBody: true }, MediaController.upload);
