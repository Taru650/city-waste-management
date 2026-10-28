import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as listRoute } from '@/app/api/v1/notifications/route';
import { GET as unreadRoute } from '@/app/api/v1/notifications/unread-count/route';
import { POST as readAllRoute } from '@/app/api/v1/notifications/read-all/route';
import { POST as readRoute } from '@/app/api/v1/notifications/[id]/read/route';
import { DELETE as deleteToken, POST as addToken } from '@/app/api/v1/notifications/push-tokens/route';
import { JobQueue } from '@/jobs/queue';
import { templates } from '@/lib/notificationTemplates';
import { FcmSender, setPushSender, type PushMessage, type PushResult, type PushSender } from '@/lib/push';
import { NotificationService } from '@/services/NotificationService';
import { call, createJurisdiction, createUser, db, loginAs, one, query, run, setupTestEnvironment, type Jurisdiction } from './helpers';

setupTestEnvironment();

let j: Jurisdiction;
beforeAll(async () => {
  j = await createJurisdiction();
});
beforeEach(async () => {
  await run(db(), 'DELETE FROM jobs');
});
afterEach(() => {
  setPushSender(undefined);
  vi.unstubAllGlobals();
});

const NO = '044680012326000457';
const tokenValue = (n: number | string) => `fcm-token-${n}-${'x'.repeat(30)}`;
async function user(role: Parameters<typeof createUser>[0] = 'CITIZEN') {
  const u = await createUser(role, j);
  return { u, token: await loginAs(u) };
}
const notify = (userIds: string[], content = templates.registered(NO), complaintId?: string) =>
  NotificationService.notify(db(), userIds, content, complaintId);

function fakePush(answer: PushResult | ((token: string) => PushResult) = 'OK') {
  const sent: { token: string; msg: PushMessage }[] = [];
  const sender: PushSender = {
    enabled: true,
    async send(token, msg) {
      sent.push({ token, msg });
      return typeof answer === 'function' ? answer(token) : answer;
    },
  };
  setPushSender(sender);
  return sent;
}

describe('in-app notifications', () => {
  it('lists a user\'s notifications newest first, in their language, with paging and an unread filter', async () => {
    const { u, token } = await user();
    await notify([u.id], templates.registered(NO));
    await notify([u.id], templates.started(NO));
    await notify([u.id], templates.resolved(NO));
    const all = await call(listRoute, 'GET', '/x', { token });
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.items[0]).toEqual(expect.objectContaining({ type: 'COMPLAINT_RESOLVED', readAt: null }));
    expect(all.body.items[0].title).toMatch(/[ऀ-ॿ]/); // Hindi is the default
    expect(Object.keys(all.body.items[0]).sort()).toEqual(['body', 'complaintId', 'createdAt', 'id', 'readAt', 'title', 'type']);

    await run(db(), `UPDATE users SET preferred_language = 'en' WHERE id = ?`, [u.id]);
    expect((await call(listRoute, 'GET', '/x', { token })).body.items[0].title).toBe('Complaint resolved — please rate');

    const page = await call(listRoute, 'GET', '/x', { token, query: { page: 2, pageSize: 2 } });
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0].type).toBe('COMPLAINT_REGISTERED');
    await call(readRoute, 'POST', '/x', { token, params: { id: all.body.items[0].id } });
    expect((await call(listRoute, 'GET', '/x', { token, query: { unread: 'true' } })).body.total).toBe(2);
    for (const q of [{ pageSize: 101 }, { page: 0 }, { pageSize: 'x' }, { unread: 'maybe' }]) {
      expect((await call(listRoute, 'GET', '/x', { token, query: q as unknown as Record<string, string | number> })).status, JSON.stringify(q)).toBe(400);
    }
  });

  it('counts unread, marks one or all read, and only ever touches the caller\'s own', async () => {
    const a = await user();
    const b = await user();
    await notify([a.u.id, b.u.id]);
    await notify([a.u.id]);
    expect((await call(unreadRoute, 'GET', '/x', { token: a.token })).body).toEqual({ count: 2 });
    expect((await call(unreadRoute, 'GET', '/x', { token: b.token })).body).toEqual({ count: 1 });

    const aItems = (await call(listRoute, 'GET', '/x', { token: a.token })).body.items;
    expect((await call(readRoute, 'POST', '/x', { token: b.token, params: { id: aItems[0].id } })).status).toBe(404); // someone else's
    expect((await call(readRoute, 'POST', '/x', { token: b.token, params: { id: 'nope' } })).status).toBe(404);
    expect((await call(unreadRoute, 'GET', '/x', { token: a.token })).body.count).toBe(2);
    expect((await call(readRoute, 'POST', '/x', { token: a.token, params: { id: aItems[0].id } })).status).toBe(204);
    expect((await call(readRoute, 'POST', '/x', { token: a.token, params: { id: aItems[0].id } })).status).toBe(204); // again: harmless
    expect((await call(unreadRoute, 'GET', '/x', { token: a.token })).body.count).toBe(1);
    expect((await call(readAllRoute, 'POST', '/x', { token: a.token })).status).toBe(204);
    expect((await call(unreadRoute, 'GET', '/x', { token: a.token })).body.count).toBe(0);
    expect((await call(unreadRoute, 'GET', '/x', { token: b.token })).body.count).toBe(1); // b untouched
    expect((await call(listRoute, 'GET', '/x')).status).toBe(401);
  });

  it('a notification belongs to the action that caused it: a rolled-back action leaves none', async () => {
    const { u } = await user();
    await expect(
      db().transaction(async (trx) => {
        await NotificationService.notify(trx, [u.id], templates.registered(NO));
        throw new Error('the action failed');
      }),
    ).rejects.toThrow();
    expect(await one(db(), `SELECT 1 AS x FROM notifications WHERE user_id = ?`, [u.id])).toBeUndefined();
  });

  it('is told once per person even if listed twice, and ignores blanks', async () => {
    const { u } = await user();
    await notify([u.id, u.id, null as unknown as string, undefined as unknown as string]);
    expect((await query(db(), `SELECT id FROM notifications WHERE user_id = ?`, [u.id])).length).toBe(1);
  });

  it('asking for a push twice queues one dispatch job', async () => {
    await NotificationService.kick();
    await NotificationService.kick();
    expect(await query(db(), `SELECT id FROM jobs WHERE queue = 'push' AND status = 'PENDING'`)).toHaveLength(1);
    await JobQueue.add('push', 'dispatch', {}, { dedupeKey: 'push-dispatch' });
    expect(await query(db(), `SELECT id FROM jobs WHERE queue = 'push'`)).toHaveLength(1);
  });
});

describe('push tokens', () => {
  it('registers a token, validates its shape, and moves it to the account that signs in on the same phone', async () => {
    const a = await user();
    const b = await user();
    const token = tokenValue('phone');
    expect((await call(addToken, 'POST', '/x', { token: a.token, body: { token, platform: 'ANDROID' } })).status).toBe(204);
    expect((await call(addToken, 'POST', '/x', { token: a.token, body: { token, platform: 'ANDROID' } })).status).toBe(204); // idempotent
    expect(await query(db(), `SELECT user_id FROM push_tokens WHERE token = ?`, [token])).toEqual([{ user_id: a.u.id }]);
    expect((await call(addToken, 'POST', '/x', { token: b.token, body: { token, platform: 'ANDROID' } })).status).toBe(204);
    expect(await query(db(), `SELECT user_id FROM push_tokens WHERE token = ?`, [token])).toEqual([{ user_id: b.u.id }]);

    for (const body of [{ token: 'short', platform: 'ANDROID' }, { token: `${token} `, platform: 'ANDROID' }, { token: `${token}'; --`, platform: 'ANDROID' }, { token, platform: 'WINDOWS' }, { token, platform: 'IOS', extra: 1 }, { token: 'x'.repeat(3000), platform: 'IOS' }]) {
      expect((await call(addToken, 'POST', '/x', { token: a.token, body })).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });

  it('keeps only the 10 most recent tokens of a user', async () => {
    const a = await user();
    for (let i = 0; i < 13; i++) {
      await call(addToken, 'POST', '/x', { token: a.token, body: { token: tokenValue(i), platform: 'ANDROID' } });
      await run(db(), `UPDATE push_tokens SET last_seen_at = DATE_ADD(NOW(3), INTERVAL ? SECOND) WHERE token = ?`, [i, tokenValue(i)]);
    }
    const kept = (await query<{ token: string }>(db(), `SELECT token FROM push_tokens WHERE user_id = ?`, [a.u.id])).map((r) => r.token);
    expect(kept).toHaveLength(10);
    expect(kept).not.toContain(tokenValue(0));
  });

  it('removal only removes your own token, and works even before the privacy notice is accepted (sign-out)', async () => {
    const a = await user();
    const b = await user();
    await call(addToken, 'POST', '/x', { token: a.token, body: { token: tokenValue('a'), platform: 'ANDROID' } });
    await call(deleteToken, 'DELETE', '/x', { token: b.token, body: { token: tokenValue('a') } });
    expect(await query(db(), `SELECT 1 FROM push_tokens WHERE token = ?`, [tokenValue('a')])).toHaveLength(1);
    expect((await call(deleteToken, 'DELETE', '/x', { token: a.token, body: { token: tokenValue('a') } })).status).toBe(204);
    expect(await query(db(), `SELECT 1 FROM push_tokens WHERE token = ?`, [tokenValue('a')])).toHaveLength(0);

    const pending = await createUser('CITIZEN', j, { consent: false });
    const t = await loginAs(pending);
    expect((await call(addToken, 'POST', '/x', { token: t, body: { token: tokenValue('p'), platform: 'ANDROID' } })).status).toBe(403);
    expect((await call(deleteToken, 'DELETE', '/x', { token: t, body: { token: tokenValue('p') } })).status).toBe(204);
  });
});

describe('push delivery', () => {
  async function pendingFor(u: { id: string }, tokens: string[]) {
    for (const t of tokens) await run(db(), `INSERT INTO push_tokens (user_id, token, platform) VALUES (?,?, 'ANDROID')`, [u.id, t]);
    await notify([u.id], templates.assigned(NO));
    return (await one(db(), `SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [u.id]))!.id as string;
  }
  const status = async (id: string) => (await one(db(), `SELECT push_status AS s, push_attempts AS a FROM notifications WHERE id = ?`, [id]))!;

  it('sends the user\'s language, only the complaint number and ids, and marks the notification sent', async () => {
    const { u } = await user();
    const sent = fakePush('OK');
    const id = await pendingFor(u, [tokenValue('one')]);
    expect(await NotificationService.dispatchPending()).toBeGreaterThanOrEqual(1);
    expect(await status(id)).toEqual({ s: 'SENT', a: 1 });
    const msg = sent.find((s) => s.msg.data.notificationId === id)!;
    expect(msg.token).toBe(tokenValue('one'));
    expect(msg.msg.body).toContain('0446-800123-26-000457');
    expect(Object.keys(msg.msg.data).sort()).toEqual(['notificationId', 'type']);
    expect(JSON.stringify(msg)).not.toContain(u.mobile);
    expect(JSON.stringify(msg)).not.toContain(u.email);
  });

  it('skips users with no token, and every user when push is switched off', async () => {
    const { u } = await user();
    fakePush('OK');
    const noToken = await pendingFor(u, []);
    await NotificationService.dispatchPending();
    expect((await status(noToken)).s).toBe('SKIPPED');

    setPushSender({ enabled: false, send: async () => 'SKIPPED' });
    const off = await pendingFor(u, [tokenValue('off')]);
    await NotificationService.dispatchPending();
    expect((await status(off)).s).toBe('SKIPPED');
  });

  it('drops a token the push service no longer knows, and gives up on permanent failures', async () => {
    const { u } = await user();
    fakePush((t) => (t === tokenValue('dead') ? 'UNREGISTERED' : 'OK'));
    const id = await pendingFor(u, [tokenValue('dead'), tokenValue('alive')]);
    await NotificationService.dispatchPending();
    expect((await status(id)).s).toBe('SENT'); // reached the live device
    expect(await query(db(), `SELECT token FROM push_tokens WHERE user_id = ?`, [u.id])).toEqual([{ token: tokenValue('alive') }]);

    fakePush('FAILED');
    const bad = await pendingFor(u, []); // the live token from above is still registered
    await NotificationService.dispatchPending();
    expect(await status(bad)).toEqual({ s: 'FAILED', a: 1 });
    expect(await query(db(), `SELECT token FROM push_tokens WHERE user_id = ?`, [u.id])).toEqual([{ token: tokenValue('alive') }]); // token kept
  });

  it('retries a temporary failure, then stops after 5 attempts', async () => {
    const { u } = await user();
    fakePush('RETRY');
    const id = await pendingFor(u, [tokenValue('flaky')]);
    for (let i = 1; i <= 4; i++) {
      await NotificationService.dispatchPending();
      expect(await status(id)).toEqual({ s: 'PENDING', a: i });
    }
    await NotificationService.dispatchPending();
    expect(await status(id)).toEqual({ s: 'FAILED', a: 5 });
    await NotificationService.dispatchPending();
    expect((await status(id)).a).toBe(5); // no further attempts
  });

  it('two dispatchers at once never send the same notification twice', async () => {
    const { u } = await user();
    const counts = new Map<string, number>();
    setPushSender({
      enabled: true,
      async send(_t, msg) {
        counts.set(msg.data.notificationId, (counts.get(msg.data.notificationId) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 2));
        return 'OK';
      },
    });
    await run(db(), `INSERT INTO push_tokens (user_id, token, platform) VALUES (?,?, 'ANDROID')`, [u.id, tokenValue('many')]);
    for (let i = 0; i < 60; i++) await notify([u.id], templates.started(NO));
    await Promise.all([NotificationService.dispatchPending(), NotificationService.dispatchPending(), NotificationService.dispatchPending()]);
    const mine = (await query<{ id: string }>(db(), `SELECT id FROM notifications WHERE user_id = ?`, [u.id])).map((r) => r.id);
    expect(mine.every((id) => counts.get(id) === 1)).toBe(true);
    expect((await query(db(), `SELECT 1 FROM notifications WHERE user_id = ? AND push_status = 'SENT'`, [u.id])).length).toBe(60);
  });
});

describe('Firebase sender', () => {
  const account = () =>
    JSON.stringify({
      project_id: 'demo-project',
      client_email: 'push@demo-project.iam.gserviceaccount.com',
      private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: 'https://oauth.example/token',
    });
  const msg: PushMessage = { title: 't', body: 'b', data: { type: 'X' } };

  function stubFetch(sendStatus: number, sendBody: unknown = {}) {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: unknown }) => {
      calls.push({ url, body: String(init.body) });
      if (url === 'https://oauth.example/token') return new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify(sendBody), { status: sendStatus });
    });
    return calls;
  }

  it('signs in with the service account once and posts the message to the project', async () => {
    const calls = stubFetch(200);
    const sender = new FcmSender(account(), 'https://fcm.example');
    expect(await sender.send('device-token-1', msg)).toBe('OK');
    expect(await sender.send('device-token-2', msg)).toBe('OK');
    expect(calls.filter((c) => c.url === 'https://oauth.example/token')).toHaveLength(1); // token cached
    const sends = calls.filter((c) => c.url.startsWith('https://fcm.example'));
    expect(sends[0].url).toBe('https://fcm.example/v1/projects/demo-project/messages:send');
    expect(JSON.parse(sends[0].body).message).toEqual(expect.objectContaining({ token: 'device-token-1', data: { type: 'X' } }));
  });

  it.each([
    [404, {}, 'UNREGISTERED'],
    [400, {}, 'FAILED'],
    [403, {}, 'FAILED'],
    [500, {}, 'RETRY'],
    [503, {}, 'RETRY'],
    [200, {}, 'OK'],
    [400, { error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'UNREGISTERED' }] } }, 'UNREGISTERED'],
  ] as const)('answers %s as %s', async (status, body, expected) => {
    stubFetch(status, body);
    expect(await new FcmSender(account(), 'https://fcm.example').send('device-token', msg)).toBe(expected);
  });

  it('asks for a retry when Google cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await new FcmSender(account(), 'https://fcm.example').send('device-token', msg)).toBe('RETRY');
  });

  it('refuses an incomplete service account at start-up', () => {
    expect(() => new FcmSender(JSON.stringify({ project_id: 'x' }), 'https://fcm.example')).toThrow(/incomplete/);
  });
});

