import type { z } from 'zod';
import { notFound } from '@/lib/errors';
import { expectedOrigin } from '@/middleware/http';
import { ApiResult, uuidParam, type Ctx } from '@/middleware/route';
import { ComplaintService } from '@/services/ComplaintService';
import type {
  assignSchema, createComplaintSchema, duplicateSchema, feedbackSchema, listComplaintsQuery, rejectSchema, resolveSchema, startSchema,
} from '@/validation/complaints';

type P = Record<string, string>;
type Id = Record<'id', string>;

/**
 * One complaint API for all clients: the citizen app, the staff app (supervisor / worker) and the website. What each
 * caller sees and may do is decided server-side by role and jurisdiction, never by which client is calling.
 */
export const ComplaintController = {
  async create({ user, body }: Ctx<z.infer<typeof createComplaintSchema>, undefined, P>) {
    return new ApiResult(await ComplaintService.create(user, body), { status: 201 });
  },
  list: ({ user, query }: Ctx<undefined, z.infer<typeof listComplaintsQuery>, P>) => ComplaintService.list(user, query),
  track: ({ user, params }: Ctx<undefined, undefined, Record<'complaintNo', string>>) => {
    if (!params.complaintNo) throw notFound('Complaint not found');
    return ComplaintService.getByNumber(user, params.complaintNo);
  },
  get: ({ user, params }: Ctx<undefined, undefined, Id>) => ComplaintService.get(user, uuidParam(params.id)),
  media: ({ user, params, req }: Ctx<undefined, undefined, Id>) => ComplaintService.listMedia(user, uuidParam(params.id), expectedOrigin(req)),
  duplicateCandidates: ({ user, params }: Ctx<undefined, undefined, Id>) => ComplaintService.duplicateCandidates(user, uuidParam(params.id)),
  // The action endpoints answer 201, exactly as the verified API does (the apps and its tests rely on it).
  async assign({ user, params, body }: Ctx<z.infer<typeof assignSchema>, undefined, Id>) {
    return new ApiResult(await ComplaintService.assign(user, uuidParam(params.id), body), { status: 201 });
  },
  async start({ user, params, body }: Ctx<z.infer<typeof startSchema>, undefined, Id>) {
    return new ApiResult(await ComplaintService.start(user, uuidParam(params.id), body), { status: 201 });
  },
  async resolve({ user, params, body }: Ctx<z.infer<typeof resolveSchema>, undefined, Id>) {
    return new ApiResult(await ComplaintService.resolve(user, uuidParam(params.id), body), { status: 201 });
  },
  async reject({ user, params, body }: Ctx<z.infer<typeof rejectSchema>, undefined, Id>) {
    return new ApiResult(await ComplaintService.reject(user, uuidParam(params.id), body), { status: 201 });
  },
  async duplicate({ user, params, body }: Ctx<z.infer<typeof duplicateSchema>, undefined, Id>) {
    return new ApiResult(await ComplaintService.markDuplicate(user, uuidParam(params.id), body), { status: 201 });
  },
  async feedback({ user, params, body }: Ctx<z.infer<typeof feedbackSchema>, undefined, Id>) {
    return new ApiResult(await ComplaintService.feedback(user, uuidParam(params.id), body), { status: 201 });
  },
};
