import type { z } from 'zod';
import { ApiResult, uuidParam, type Ctx } from '@/middleware/route';
import { expectedOrigin } from '@/middleware/http';
import { DeviceService } from '@/services/DeviceService';
import { MediaService } from '@/services/MediaService';
import type { confirmUploadSchema, createUploadSchema, registerDeviceSchema } from '@/validation/media';
import { HttpError } from '@/lib/errors';

type P = Record<string, string>;

export const MediaController = {
  async registerDevice({ user, body, client }: Ctx<z.infer<typeof registerDeviceSchema>, undefined, P>) {
    return new ApiResult(await DeviceService.register(user, body, client.ip), { status: 201 });
  },
  listDevices: ({ user }: Ctx<undefined, undefined, P>) => DeviceService.list(user),
  async revokeDevice({ user, params, client }: Ctx<undefined, undefined, P>) {
    await DeviceService.revoke(user, uuidParam(params.id), client.ip);
    return new ApiResult(null, { status: 204 });
  },

  async createUpload({ user, body, req }: Ctx<z.infer<typeof createUploadSchema>, undefined, P>) {
    return new ApiResult(await MediaService.createUpload(user, body as never, expectedOrigin(req)), { status: 201 });
  },

  async upload({ user, params, req }: Ctx<undefined, undefined, P>) {
    await MediaService.receiveUpload(user, uuidParam(params.id), req);
    return new ApiResult(null, { status: 204 });
  },

  confirm: ({ user, params, body, client }: Ctx<z.infer<typeof confirmUploadSchema>, undefined, P>) =>
    MediaService.confirm(user, uuidParam(params.id), body, client.ip),

  get: ({ user, params }: Ctx<undefined, undefined, P>) => MediaService.getOwn(user, uuidParam(params.id)),

  /** Public: the signed link in the query string is the authorisation. */
  file({ params, req }: Ctx<undefined, undefined, P>) {
    const q = new URL(req.url).searchParams;
    const id = uuidParam(params.id);
    const variant = q.get('v') ?? '';
    const exp = q.get('exp') ?? '';
    const sig = q.get('sig') ?? '';
    if (!sig || !exp) throw new HttpError(403, 'This link is invalid or has expired');
    return MediaService.serveFile(id, variant, exp, sig, req.headers.get('range'));
  },
};
