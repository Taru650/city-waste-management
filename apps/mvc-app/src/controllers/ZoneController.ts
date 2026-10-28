import type { z } from 'zod';
import { ApiResult, uuidParam, type Ctx } from '@/middleware/route';
import { ZoneService } from '@/services/ZoneService';
import type { createZoneSchema, listZonesQuery, updateZoneSchema } from '@/validation/zones';

type P = Record<string, string>;

export const ZoneController = {
  list: ({ user, query }: Ctx<undefined, z.infer<typeof listZonesQuery>, P>) => ZoneService.list(user, query),
  get: ({ user, params }: Ctx<undefined, undefined, P>) => ZoneService.get(user, uuidParam(params.id)),
  async create({ user, body }: Ctx<z.infer<typeof createZoneSchema>, undefined, P>) {
    return new ApiResult(await ZoneService.create(user, body), { status: 201 });
  },
  update: ({ user, params, body }: Ctx<z.infer<typeof updateZoneSchema>, undefined, P>) => ZoneService.update(user, uuidParam(params.id), body),
};
