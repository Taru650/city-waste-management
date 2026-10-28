import { db } from '@/db/connection';
import type { Db } from '@/db/sql';
import { JobQueue, QUEUES } from '@/jobs/queue';
import { notFound } from '@/lib/errors';
import type { NotificationContent } from '@/lib/notificationTemplates';
import { getPushSender } from '@/lib/push';
import { NotificationModel, type PendingPush } from '@/models/NotificationModel';
import type { AuthUser } from '@/middleware/auth';

export const MAX_PUSH_ATTEMPTS = 5;
export const MAX_TOKENS_PER_USER = 10;
/** Small batches: rows stay locked while the push service is called. */
const DISPATCH_BATCH = 25;

/**
 * In-app notifications, which double as the push outbox. Rows are written inside the same transaction as the
 * event that caused them (a rolled-back action never notifies); a background job then sends them to FCM.
 */
export const NotificationService = {
  /** Queue notifications for users, inside the caller's transaction. */
  async notify(d: Db, userIds: (string | null | undefined)[], content: NotificationContent, complaintId?: string): Promise<void> {
    const ids = [...new Set(userIds.filter((u): u is string => !!u))];
    await NotificationModel.insertMany(d, ids, content, complaintId ?? null);
  },

  subAdminsOf: (d: Db, ulbId: string) => NotificationModel.subAdminIds(d, ulbId),

  /**
   * Call after the transaction that wrote notifications has committed. Never throws: if the queue is
   * unavailable the periodic dispatch job still delivers.
   */
  async kick(): Promise<void> {
    await JobQueue.add(QUEUES.PUSH, 'dispatch', {}, { dedupeKey: 'push-dispatch' }).catch((err) => console.warn('[notifications] kick failed:', (err as Error).message));
  },

  async dispatchPending(): Promise<number> {
    let processed = 0;
    for (;;) {
      const n = await db().transaction(async (trx) => {
        const rows = await NotificationModel.claimPending(trx, DISPATCH_BATCH);
        for (const row of rows) await deliver(trx, row);
        return rows.length;
      });
      processed += n;
      if (n < DISPATCH_BATCH) return processed;
    }
  },

  async list(user: AuthUser, q: { unread?: boolean; page: number; pageSize: number }) {
    const unread = !!q.unread;
    const [total, items] = await Promise.all([
      NotificationModel.count(db(), user.id, unread),
      NotificationModel.list(db(), user.id, unread, q.pageSize, (q.page - 1) * q.pageSize),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items };
  },

  async unreadCount(user: AuthUser) {
    return { count: await NotificationModel.count(db(), user.id, true) };
  },

  async markRead(user: AuthUser, id: string) {
    if (!(await NotificationModel.markRead(db(), user.id, id))) throw notFound('Notification not found');
  },

  markAllRead: (user: AuthUser) => NotificationModel.markAllRead(db(), user.id),

  async registerToken(user: AuthUser, token: string, platform: string) {
    await db().transaction(async (trx) => {
      await NotificationModel.upsertToken(trx, user.id, token, platform);
      await NotificationModel.trimTokens(trx, user.id, MAX_TOKENS_PER_USER);
    });
  },

  removeToken: (user: AuthUser, token: string) => NotificationModel.deleteToken(db(), user.id, token),
};

async function deliver(d: Db, row: PendingPush): Promise<void> {
  const push = getPushSender();
  const tokens = push.enabled ? await NotificationModel.tokensOf(d, row.user_id) : [];
  if (!tokens.length) {
    await NotificationModel.setPushStatus(d, row.id, 'SKIPPED', row.push_attempts);
    return;
  }
  const data: Record<string, string> = { type: row.type, notificationId: row.id, ...(row.complaint_id ? { complaintId: row.complaint_id } : {}) };
  let sent = false;
  let retry = false;
  for (const t of tokens) {
    const result = await push.send(t.token, { title: row.title, body: row.body, data });
    if (result === 'OK') sent = true;
    else if (result === 'UNREGISTERED') await NotificationModel.deleteTokenById(d, t.id);
    else if (result === 'RETRY') retry = true;
  }
  const attempts = row.push_attempts + 1;
  const status = sent ? 'SENT' : retry && attempts < MAX_PUSH_ATTEMPTS ? 'PENDING' : 'FAILED';
  await NotificationModel.setPushStatus(d, row.id, status, attempts);
}
