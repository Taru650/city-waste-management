import type { z } from 'zod';
import { ApiResult, uuidParam, type Ctx } from '@/middleware/route';
import { NotificationService } from '@/services/NotificationService';
import type { listNotificationsQuery, pushTokenSchema, removePushTokenSchema } from '@/validation/notifications';

type P = Record<string, string>;
const noContent = () => new ApiResult(null, { status: 204 });

export const NotificationController = {
  list: ({ user, query }: Ctx<undefined, z.infer<typeof listNotificationsQuery>, P>) => NotificationService.list(user, query),
  unreadCount: ({ user }: Ctx<undefined, undefined, P>) => NotificationService.unreadCount(user),
  async readAll({ user }: Ctx<undefined, undefined, P>) {
    await NotificationService.markAllRead(user);
    return noContent();
  },
  async read({ user, params }: Ctx<undefined, undefined, P>) {
    await NotificationService.markRead(user, uuidParam(params.id));
    return noContent();
  },
  async registerToken({ user, body }: Ctx<z.infer<typeof pushTokenSchema>, undefined, P>) {
    await NotificationService.registerToken(user, body.token, body.platform);
    return noContent();
  },
  async removeToken({ user, body }: Ctx<z.infer<typeof removePushTokenSchema>, undefined, P>) {
    await NotificationService.removeToken(user, body.token);
    return noContent();
  },
};
