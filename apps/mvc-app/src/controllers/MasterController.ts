import type { z } from 'zod';
import { ApiResult, uuidParam, type Ctx } from '@/middleware/route';
import { MasterService } from '@/services/MasterService';
import type {
  createAreaSchema, createDistrictSchema, createUlbSchema, createWardSchema, locateQuery, updateAreaSchema, updateComplaintTypeSchema, updateWardSchema,
} from '@/validation/masters';

type Id = Record<'id', string>;
type B<T extends z.ZodType> = Ctx<z.infer<T>, undefined, Record<string, string>>;
const created = (body: unknown) => new ApiResult(body, { status: 201 });

export const MasterController = {
  districts: () => MasterService.listDistricts(),
  ulbs: ({ params }: Ctx<undefined, undefined, Id>) => MasterService.listUlbs(uuidParam(params.id)),
  wards: ({ params }: Ctx<undefined, undefined, Id>) => MasterService.listWards(uuidParam(params.id)),
  complaintTypes: () => MasterService.listComplaintTypes(false),
  allComplaintTypes: () => MasterService.listComplaintTypes(true),
  boundaries: ({ user, params }: Ctx<undefined, undefined, Id>) => MasterService.wardBoundaries(user, uuidParam(params.id)),
  locate: ({ query }: Ctx<undefined, z.infer<typeof locateQuery>, Record<string, string>>) => MasterService.locate(query.lat, query.lng),
  areas: ({ user, params }: Ctx<undefined, undefined, Id>) => MasterService.listAreas(user, uuidParam(params.id)),

  async createDistrict({ user, body }: B<typeof createDistrictSchema>) {
    return created(await MasterService.createDistrict(user, body));
  },
  async createUlb({ user, body }: B<typeof createUlbSchema>) {
    return created(await MasterService.createUlb(user, body));
  },
  async createWard({ user, body }: B<typeof createWardSchema>) {
    return created(await MasterService.createWard(user, body));
  },
  updateWard: ({ user, body, params }: Ctx<z.infer<typeof updateWardSchema>, undefined, Id>) => MasterService.updateWard(user, uuidParam(params.id), body),
  async createArea({ user, body }: B<typeof createAreaSchema>) {
    return created(await MasterService.createArea(user, body));
  },
  updateArea: ({ user, body, params }: Ctx<z.infer<typeof updateAreaSchema>, undefined, Id>) => MasterService.updateArea(user, uuidParam(params.id), body),
  updateComplaintType: ({ user, body, params }: Ctx<z.infer<typeof updateComplaintTypeSchema>, undefined, Id>) =>
    MasterService.updateComplaintType(user, uuidParam(params.id), body),
};
