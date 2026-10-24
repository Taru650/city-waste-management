import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../../common/auth-user';
import { mutateReturning } from '../../common/db';
import { JobsService, QUEUES } from '../jobs/jobs.service';
import { ListNotificationsQuery, PushTokenDto } from './dto/notifications.dto';
import { PushSender } from './push-sender';
import { NotificationContent } from './templates';

export const MAX_PUSH_ATTEMPTS = 5;
export const MAX_TOKENS_PER_USER = 10;
/** Small batches: rows stay locked while FCM is called. */
const DISPATCH_BATCH = 25;

/**
 * In-app notifications, which double as the push outbox. Rows are written inside the
 * same transaction as the event that caused them (so a rolled-back action never notifies),
 * then a worker sends them to FCM.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger('Notifications');

  constructor(private readonly ds: DataSource, private readonly jobs: JobsService, private readonly push: PushSender) {}

  onModuleInit() {
    this.jobs.process(QUEUES.PUSH, 'dispatch', () => this.dispatchPending());
    this.jobs.process(QUEUES.MAINTENANCE, 'push-dispatch', () => this.dispatchPending());
    // Safety net in case a post-commit kick was lost (process crash between commit and enqueue).
    this.jobs.every(QUEUES.MAINTENANCE, 'push-dispatch', 30_000);
  }

  /** Queue notifications for users, inside the caller's transaction. */
  async notify(m: EntityManager, userIds: (string | null | undefined)[], content: NotificationContent, complaintId?: string) {
    const ids = [...new Set(userIds.filter((u): u is string => !!u))];
    if (!ids.length) return;
    await m.query(
      `INSERT INTO notifications (user_id, type, complaint_id, title_en, title_hi, body_en, body_hi)
       SELECT u, $2, $3, $4, $5, $6, $7 FROM unnest($1::uuid[]) AS u`,
      [ids, content.type, complaintId ?? null, content.title.en, content.title.hi, content.body.en, content.body.hi],
    );
  }

  /** Sub Admins of a ULB (escalations, unrouted complaints). */
  async subAdminsOf(m: EntityManager, ulbId: string): Promise<string[]> {
    const rows = await m.query(`SELECT id FROM users WHERE role = 'SUB_ADMIN' AND ulb_id = $1 AND status = 'ACTIVE'`, [ulbId]);
    return rows.map((r: { id: string }) => r.id);
  }

  /**
   * Call (and await) after the transaction that wrote notifications has committed, so the
   * dispatch job is queued before the request is acknowledged. Never throws: if Redis is
   * down the periodic push-dispatch sweep still delivers.
   */
  async kick(): Promise<void> {
    await this.jobs
      .add(QUEUES.PUSH, 'dispatch', {}, { removeOnComplete: true, removeOnFail: 100 })
      .then(() => undefined, (err) => this.logger.warn(`kick failed: ${err}`));
  }

  async dispatchPending(): Promise<number> {
    let processed = 0;
    for (;;) {
      const n = await this.ds.transaction(async (m) => {
        const rows: { id: string; user_id: string; type: string; complaint_id: string | null; title: string; body: string; push_attempts: number }[] =
          await m.query(
            `SELECT n.id, n.user_id, n.type, n.complaint_id, n.push_attempts,
                    CASE WHEN u.preferred_language = 'en' THEN n.title_en ELSE n.title_hi END AS title,
                    CASE WHEN u.preferred_language = 'en' THEN n.body_en ELSE n.body_hi END AS body
               FROM notifications n JOIN users u ON u.id = n.user_id
              WHERE n.push_status = 'PENDING'
              ORDER BY n.created_at LIMIT $1
              FOR UPDATE OF n SKIP LOCKED`,
            [DISPATCH_BATCH],
          );
        for (const row of rows) await this.deliver(m, row);
        return rows.length;
      });
      processed += n;
      if (n < DISPATCH_BATCH) return processed;
    }
  }

  private async deliver(
    m: EntityManager,
    row: { id: string; user_id: string; type: string; complaint_id: string | null; title: string; body: string; push_attempts: number },
  ) {
    const tokens: { id: string; token: string }[] = this.push.enabled
      ? await m.query(`SELECT id, token FROM push_tokens WHERE user_id = $1`, [row.user_id])
      : [];
    if (!tokens.length) {
      await m.query(`UPDATE notifications SET push_status = 'SKIPPED' WHERE id = $1`, [row.id]);
      return;
    }
    const data: Record<string, string> = { type: row.type, notificationId: row.id, ...(row.complaint_id ? { complaintId: row.complaint_id } : {}) };
    let sent = false;
    let retry = false;
    for (const t of tokens) {
      const result = await this.push.send(t.token, { title: row.title, body: row.body, data });
      if (result === 'OK') sent = true;
      else if (result === 'UNREGISTERED') await m.query(`DELETE FROM push_tokens WHERE id = $1`, [t.id]);
      else if (result === 'RETRY') retry = true;
    }
    const attempts = row.push_attempts + 1;
    const status = sent ? 'SENT' : retry && attempts < MAX_PUSH_ATTEMPTS ? 'PENDING' : 'FAILED';
    await m.query(`UPDATE notifications SET push_status = $2, push_attempts = $3 WHERE id = $1`, [row.id, status, attempts]);
  }

  // ---- user-facing ----

  async list(user: AuthUser, q: ListNotificationsQuery) {
    const unread = q.unread ? 'AND read_at IS NULL' : '';
    const [{ total }] = await this.ds.query(`SELECT count(*)::int AS total FROM notifications WHERE user_id = $1 ${unread}`, [user.id]);
    const items = await this.ds.query(
      `SELECT n.id, n.type, n.complaint_id AS "complaintId",
              CASE WHEN u.preferred_language = 'en' THEN n.title_en ELSE n.title_hi END AS title,
              CASE WHEN u.preferred_language = 'en' THEN n.body_en ELSE n.body_hi END AS body,
              n.read_at AS "readAt", n.created_at AS "createdAt"
         FROM notifications n JOIN users u ON u.id = n.user_id
        WHERE n.user_id = $1 ${unread}
        ORDER BY n.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      [user.id],
    );
    return { total, page: q.page, pageSize: q.pageSize, items };
  }

  async unreadCount(user: AuthUser) {
    const [{ count }] = await this.ds.query(`SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [user.id]);
    return { count };
  }

  async markRead(user: AuthUser, id: string) {
    const rows = await mutateReturning(
      this.ds,
      `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, user.id],
    );
    if (!rows.length) throw new NotFoundException('Notification not found');
  }

  async markAllRead(user: AuthUser) {
    await this.ds.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [user.id]);
  }

  /**
   * A token identifies an app install. If another account signs in on the same phone the
   * token moves to that account, so the previous user's notifications stop arriving there.
   */
  async registerToken(user: AuthUser, dto: PushTokenDto) {
    await this.ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO push_tokens (user_id, token, platform) VALUES ($1, $2, $3)
         ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen_at = now()`,
        [user.id, dto.token, dto.platform],
      );
      await m.query(
        `DELETE FROM push_tokens WHERE user_id = $1 AND id NOT IN (
           SELECT id FROM push_tokens WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT $2)`,
        [user.id, MAX_TOKENS_PER_USER],
      );
    });
  }

  async removeToken(user: AuthUser, token: string) {
    await this.ds.query(`DELETE FROM push_tokens WHERE token = $1 AND user_id = $2`, [token, user.id]);
  }
}
