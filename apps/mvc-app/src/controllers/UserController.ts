import type { z } from 'zod';
import { ApiResult, uuidParam, type Ctx } from '@/middleware/route';
import { UserService } from '@/services/UserService';
import type { createStaffSchema, listUsersQuery, updateStatusSchema } from '@/validation/users';

type Id = Record<'id', string>;

export const UserController = {
  async create({ user, body, client }: Ctx<z.infer<typeof createStaffSchema>, undefined, Record<string, string>>) {
    return new ApiResult(await UserService.createStaff(user, body, client.ip), { status: 201 });
  },
  list: ({ user, query }: Ctx<undefined, z.infer<typeof listUsersQuery>, Record<string, string>>) => UserService.list(user, query.role),
  workers: ({ user }: Ctx<undefined, undefined, Record<string, string>>) => UserService.workers(user),
  setStatus: ({ user, body, params, client }: Ctx<z.infer<typeof updateStatusSchema>, undefined, Id>) =>
    UserService.setStatus(user, uuidParam(params.id), body.status, client.ip),
  async resetPassword({ user, params, client }: Ctx<undefined, undefined, Id>) {
    return new ApiResult(await UserService.helpdeskResetPassword(user, uuidParam(params.id), client.ip), { status: 201 });
  },
};
