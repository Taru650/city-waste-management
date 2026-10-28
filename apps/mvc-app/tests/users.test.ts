import { beforeAll, describe, expect, it } from 'vitest';
import { GET as listUsers, POST as createUser_ } from '@/app/api/v1/users/route';
import { GET as workersRoute } from '@/app/api/v1/users/workers/route';
import { PATCH as setStatus } from '@/app/api/v1/users/[id]/status/route';
import { POST as resetPassword } from '@/app/api/v1/users/[id]/reset-password/route';
import { POST as login } from '@/app/api/v1/auth/login/route';
import { POST as refresh } from '@/app/api/v1/auth/refresh/route';
import { GET as me } from '@/app/api/v1/auth/me/route';
import { POST as changePassword } from '@/app/api/v1/auth/change-password/route';
import { newId } from '@/lib/ids';
import { PASSWORD, call, createJurisdiction, createUser, db, loginAs, one, run, uniqueMobile, setupTestEnvironment, type Jurisdiction, type TestUser } from './helpers';

setupTestEnvironment();

let a: Jurisdiction;
let b: Jurisdiction;
const tok: Record<string, string> = {};
const people: Record<string, TestUser> = {};

beforeAll(async () => {
  a = await createJurisdiction();
  b = await createJurisdiction();
  const make = async (key: string, role: Parameters<typeof createUser>[0], j?: Jurisdiction) => {
    people[key] = await createUser(role, j);
    tok[key] = await loginAs(people[key]);
  };
  await make('web', 'WEB_ADMIN');
  await make('distA', 'DISTRICT_ADMIN', a);
  await make('distB', 'DISTRICT_ADMIN', b);
  await make('subA', 'SUB_ADMIN', a);
  await make('subB', 'SUB_ADMIN', b);
  await make('supA', 'SUPERVISOR', a);
  await make('workerA', 'WORKER', a);
  await make('citizen', 'CITIZEN', a);
});

const newStaff = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ role: 'SUPERVISOR', name: 'Ravi Kumar', mobile: uniqueMobile(), ...over });
const post = (token: string | undefined, body: unknown) => call(createUser_, 'POST', '/api/v1/users', { token, body });
const row = (id: string) => one(db(), `SELECT * FROM users WHERE id = ?`, [id]);

describe('creating staff follows the hierarchy', () => {
  it('Web Admin creates a District Admin, who must replace the temporary password before doing anything else', async () => {
    const mobile = uniqueMobile();
    const r = await post(tok.web, { role: 'DISTRICT_ADMIN', name: 'Meena Joshi', mobile, email: `Meena${mobile}@Example.in`, districtId: a.districtId });
    expect(r.status).toBe(201);
    expect(r.body.tempPassword).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(r.body.tempPassword).not.toMatch(/[0OIl1]/);
    const stored = (await row(r.body.id))!;
    expect(stored).toEqual(expect.objectContaining({ role: 'DISTRICT_ADMIN', status: 'ACTIVE', district_id: a.districtId }));
    expect(stored.ulb_id).toBeNull();
    expect(stored.must_change_password).toBeTruthy();
    expect(stored.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.password_hash).not.toContain(r.body.tempPassword);
    expect(stored.mobile_enc).not.toContain(mobile);
    expect(stored.created_by).toBe(people.web.id);

    const session = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: mobile, password: r.body.tempPassword } });
    expect(session.status).toBe(200);
    const token = session.body.accessToken;
    expect((await call(me, 'GET', '/x', { token })).body.mustChangePassword).toBe(true);
    const blocked = await call(listUsers, 'GET', '/api/v1/users', { token });
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/Password change required/);
    const changed = await call(changePassword, 'POST', '/x', { token, body: { currentPassword: r.body.tempPassword, newPassword: 'Mine#Secure2026x' } });
    expect(changed.status).toBe(200);
    expect((await call(listUsers, 'GET', '/api/v1/users', { token: changed.body.accessToken })).status).toBe(200);
  });

  it('District Admin creates Sub Admins in their own district only, and must name the ULB', async () => {
    const ok = await post(tok.distA, { role: 'SUB_ADMIN', name: 'Sunil Rao', mobile: uniqueMobile(), ulbId: a.ulbId });
    expect(ok.status).toBe(201);
    expect(await row(ok.body.id)).toEqual(expect.objectContaining({ role: 'SUB_ADMIN', ulb_id: a.ulbId, district_id: a.districtId }));
    expect((await post(tok.distA, { role: 'SUB_ADMIN', name: 'No Ulb', mobile: uniqueMobile() })).status).toBe(400);
    expect((await post(tok.distA, { role: 'SUB_ADMIN', name: 'Wrong Ulb', mobile: uniqueMobile(), ulbId: b.ulbId })).status).toBe(403);
    expect((await post(tok.distA, { role: 'SUB_ADMIN', name: 'Ghost Ulb', mobile: uniqueMobile(), ulbId: newId() })).status).toBe(404);
  });

  it('Sub Admin creates supervisors and workers inside their own ULB, whatever the request says', async () => {
    const r = await post(tok.subA, newStaff({ role: 'WORKER', districtId: b.districtId, ulbId: b.ulbId }));
    expect(r.status).toBe(201);
    expect(await row(r.body.id)).toEqual(expect.objectContaining({ ulb_id: a.ulbId, district_id: a.districtId }));
    const withArea = await post(tok.subA, newStaff({ areaId: a.areaId }));
    expect(withArea.status).toBe(201);
    expect((await row(withArea.body.id))!.area_id).toBe(a.areaId);
    expect((await post(tok.subA, newStaff({ areaId: b.areaId }))).status).toBe(400);
    expect((await post(tok.subA, newStaff({ areaId: newId() }))).status).toBe(400);
  });

  it('no role can create its own level or above, and the roles at the bottom cannot create anyone', async () => {
    const cases: [string, string, number][] = [
      ['web', 'SUB_ADMIN', 403], ['web', 'WEB_ADMIN', 403], ['web', 'WORKER', 403],
      ['distA', 'DISTRICT_ADMIN', 403], ['distA', 'SUPERVISOR', 403], ['distA', 'WEB_ADMIN', 403],
      ['subA', 'SUB_ADMIN', 403], ['subA', 'DISTRICT_ADMIN', 403], ['subA', 'WEB_ADMIN', 403],
      ['supA', 'WORKER', 403], ['workerA', 'WORKER', 403], ['citizen', 'WORKER', 403],
    ];
    for (const [who, role, status] of cases) {
      expect((await post(tok[who], { ...newStaff({ role }), districtId: a.districtId, ulbId: a.ulbId })).status, `${who} -> ${role}`).toBe(status);
    }
    expect((await post(undefined, newStaff())).status).toBe(401);
    expect((await post(tok.subA, newStaff({ role: 'CITIZEN' }))).status).toBe(400);
  });

  it('refuses extra fields (status, password, created_by...), bad input, and duplicate contacts', async () => {
    for (const extra of [{ status: 'ACTIVE' }, { passwordHash: 'x' }, { mustChangePassword: false }, { createdBy: newId() }, { password: 'Known#Pass2026' }]) {
      expect((await post(tok.subA, newStaff(extra))).status, JSON.stringify(extra)).toBe(400);
    }
    for (const bad of [{ mobile: '12345' }, { name: '' }, { name: '<script>' }, { email: 'not-an-email' }, { role: 'GOD' }]) {
      expect((await post(tok.subA, newStaff(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    const first = newStaff({ email: `dup${uniqueMobile()}@example.in` });
    expect((await post(tok.subA, first)).status).toBe(201);
    expect((await post(tok.subA, { ...newStaff(), mobile: first.mobile })).status).toBe(409);
    expect((await post(tok.subA, { ...newStaff(), email: String(first.email).toUpperCase() })).status).toBe(409);
    expect((await post(tok.subA, { ...newStaff(), mobile: people.citizen.mobile })).status).toBe(409); // also against citizens
  });

  it('temporary staff: expiry must be in the future, within a year, and only for supervisors and workers', async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const ok = await post(tok.subA, newStaff({ role: 'WORKER', accessExpiresAt: soon }));
    expect(ok.status).toBe(201);
    expect((await row(ok.body.id))!.access_expires_at).toBeTruthy();
    expect((await post(tok.subA, newStaff({ accessExpiresAt: new Date(Date.now() - 60_000).toISOString() }))).status).toBe(400);
    expect((await post(tok.subA, newStaff({ accessExpiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() }))).status).toBe(400);
    expect((await post(tok.subA, newStaff({ accessExpiresAt: 'next week' }))).status).toBe(400);
    expect((await post(tok.distA, { role: 'SUB_ADMIN', name: 'Temp Admin', mobile: uniqueMobile(), ulbId: a.ulbId, accessExpiresAt: soon })).status).toBe(400);
  });
});

describe('listing staff', () => {
  it('each admin sees only the staff of their own jurisdiction, with decrypted mobile numbers and no secrets', async () => {
    const mine = await post(tok.subA, newStaff({ name: 'Visible Only To A' }));
    const theirs = await post(tok.subB, newStaff({ name: 'Visible Only To B' }));
    const asSubA = await call(listUsers, 'GET', '/api/v1/users', { token: tok.subA });
    const ids = (r: { body: { id: string }[] }) => r.body.map((u) => u.id);
    expect(ids(asSubA)).toContain(mine.body.id);
    expect(ids(asSubA)).not.toContain(theirs.body.id);
    expect(asSubA.body.every((u: { role: string }) => u.role !== 'CITIZEN')).toBe(true);
    const created = asSubA.body.find((u: { id: string }) => u.id === mine.body.id);
    expect(created.mobile).toMatch(/^[6-9]\d{9}$/);
    expect(JSON.stringify(asSubA.body)).not.toMatch(/argon2|password|_enc|hash|token/i);

    const asDistA = await call(listUsers, 'GET', '/api/v1/users', { token: tok.distA });
    expect(ids(asDistA)).toContain(mine.body.id);
    expect(ids(asDistA)).not.toContain(theirs.body.id);
    const asWeb = await call(listUsers, 'GET', '/api/v1/users', { token: tok.web });
    expect(ids(asWeb)).toEqual(expect.arrayContaining([mine.body.id, theirs.body.id]));
  });

  it('filters by role, rejects an unknown role, and is closed to supervisors, workers, citizens and visitors', async () => {
    const onlyWorkers = await call(listUsers, 'GET', '/x', { token: tok.subA, query: { role: 'WORKER' } });
    expect(onlyWorkers.status).toBe(200);
    expect(onlyWorkers.body.every((u: { role: string }) => u.role === 'WORKER')).toBe(true);
    expect((await call(listUsers, 'GET', '/x', { token: tok.subA, query: { role: 'GOD' } })).status).toBe(400);
    expect((await call(listUsers, 'GET', '/x', { token: tok.subA, query: { role: "WORKER' OR 1=1" } })).status).toBe(400);
    for (const k of ['supA', 'workerA', 'citizen']) expect((await call(listUsers, 'GET', '/x', { token: tok[k] })).status, k).toBe(403);
    expect((await call(listUsers, 'GET', '/x')).status).toBe(401);
  });

  it('the worker list (for assignment) shows only active, current workers of the caller\'s ULB', async () => {
    const j = await createJurisdiction();
    const sub = await createUser('SUB_ADMIN', j);
    const sup = await createUser('SUPERVISOR', j);
    const good = await createUser('WORKER', j);
    const disabled = await createUser('WORKER', j, { status: 'DISABLED' });
    const expired = await createUser('WORKER', j);
    await run(db(), `UPDATE users SET access_expires_at = DATE_SUB(NOW(3), INTERVAL 1 DAY) WHERE id = ?`, [expired.id]);
    const elsewhere = await createUser('WORKER', b);
    for (const who of [sub, sup]) {
      const r = await call(workersRoute, 'GET', '/api/v1/users/workers', { token: await loginAs(who) });
      expect(r.status).toBe(200);
      expect(r.body.map((w: { id: string }) => w.id)).toEqual([good.id]);
      expect(r.body[0]).toEqual(expect.objectContaining({ openTasks: 0, name: expect.any(String) }));
    }
    void disabled; void elsewhere;
    for (const k of ['web', 'distA', 'workerA', 'citizen']) expect((await call(workersRoute, 'GET', '/x', { token: tok[k] })).status, k).toBe(403);
  });
});

describe('disabling and re-enabling accounts', () => {
  async function victim(j: Jurisdiction, role: Parameters<typeof createUser>[0] = 'SUPERVISOR') {
    const u = await createUser(role, j);
    const s = (await call(login, 'POST', '/x', { body: { identifier: u.mobile, password: u.password } })).body;
    return { u, s };
  }

  it('disabling ends the user\'s sessions at once; re-enabling lets them sign in again', async () => {
    const { u, s } = await victim(a);
    expect((await call(me, 'GET', '/x', { token: s.accessToken })).status).toBe(200);
    const off = await call(setStatus, 'PATCH', '/x', { token: tok.subA, params: { id: u.id }, body: { status: 'DISABLED' } });
    expect(off.status).toBe(200);
    expect((await call(me, 'GET', '/x', { token: s.accessToken })).status).toBe(401);
    expect((await call(login, 'POST', '/x', { body: { identifier: u.mobile, password: u.password } })).status).toBe(401);
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE action = 'USER_DISABLED' AND entity_id = ? AND actor_id = ?`, [u.id, people.subA.id])).toBeTruthy();
    expect((await call(setStatus, 'PATCH', '/x', { token: tok.subA, params: { id: u.id }, body: { status: 'ACTIVE' } })).status).toBe(200);
    expect((await call(login, 'POST', '/x', { body: { identifier: u.mobile, password: u.password } })).status).toBe(200);
    // sessions from before the suspension stay dead: re-enabling must not revive a stolen or forgotten token
    expect((await call(me, 'GET', '/x', { token: s.accessToken })).status).toBe(401);
    expect((await call(refresh, 'POST', '/x', { body: { refreshToken: s.refreshToken } })).status).toBe(401);
  });

  it('only the manager one level up, in the same jurisdiction, can change a status; everything else is "not found"', async () => {
    const { u } = await victim(a);
    const set = (token: string, id: string, body: unknown = { status: 'DISABLED' }) => call(setStatus, 'PATCH', '/x', { token, params: { id }, body });
    for (const k of ['subB', 'distB', 'distA', 'web']) expect((await set(tok[k], u.id)).status, k).toBe(404); // not their direct report
    for (const k of ['supA', 'workerA', 'citizen']) expect((await set(tok[k], u.id)).status, k).toBe(403);
    expect((await set(tok.subA, people.subA.id)).status).toBe(404); // not yourself
    expect((await set(tok.subA, people.distA.id)).status).toBe(404); // not your manager
    expect((await set(tok.subA, people.subB.id)).status).toBe(404); // not another ULB's admin
    expect((await set(tok.web, people.distA.id)).status).toBe(200); // Web Admin manages District Admins
    expect((await set(tok.web, people.distA.id, { status: 'ACTIVE' })).status).toBe(200);
    expect((await set(tok.subA, 'not-a-uuid')).status).toBe(404);
    expect((await set(tok.subA, newId())).status).toBe(404);
    expect((await set(tok.subA, u.id, { status: 'UNVERIFIED_MOBILE' })).status).toBe(400);
    expect((await set(tok.subA, u.id, { status: 'DISABLED', role: 'WEB_ADMIN' })).status).toBe(400);
    expect((await row(u.id))!.status).toBe('ACTIVE');
  });

  it('a Sub Admin runs the helpdesk for citizens whose home ULB is theirs, and no others', async () => {
    const home = await createUser('CITIZEN', a);
    const away = await createUser('CITIZEN', b);
    expect((await call(setStatus, 'PATCH', '/x', { token: tok.subA, params: { id: home.id }, body: { status: 'DISABLED' } })).status).toBe(200);
    expect((await call(setStatus, 'PATCH', '/x', { token: tok.subA, params: { id: away.id }, body: { status: 'DISABLED' } })).status).toBe(404);
    expect((await row(away.id))!.status).toBe('ACTIVE');
  });
});

describe('helpdesk password reset', () => {
  it('issues a one-time temporary password, ends every session, clears a lockout and forces a change', async () => {
    const u = await createUser('WORKER', a);
    const old = (await call(login, 'POST', '/x', { body: { identifier: u.mobile, password: u.password } })).body;
    for (let i = 0; i < 5; i++) await call(login, 'POST', '/x', { body: { identifier: u.mobile, password: 'Wrong#password1' } });
    expect((await call(login, 'POST', '/x', { body: { identifier: u.mobile, password: u.password } })).status).toBe(401); // locked

    const r = await call(resetPassword, 'POST', '/x', { token: tok.subA, params: { id: u.id } });
    expect(r.status).toBe(201);
    expect(r.body.tempPassword).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(Object.keys(r.body).sort()).toEqual(['id', 'tempPassword']);
    expect((await call(me, 'GET', '/x', { token: old.accessToken })).status).toBe(401);
    expect((await call(login, 'POST', '/x', { body: { identifier: u.mobile, password: u.password } })).status).toBe(401); // old password gone
    const fresh = await call(login, 'POST', '/x', { body: { identifier: u.mobile, password: r.body.tempPassword } });
    expect(fresh.status).toBe(200);
    expect((await call(me, 'GET', '/x', { token: fresh.body.accessToken })).body.mustChangePassword).toBe(true);
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE action = 'HELPDESK_PASSWORD_RESET' AND entity_id = ?`, [u.id])).toBeTruthy();
    // the temporary password is not stored anywhere in clear
    expect(JSON.stringify(await one(db(), `SELECT * FROM audit_logs WHERE action = 'HELPDESK_PASSWORD_RESET' AND entity_id = ?`, [u.id]))).not.toContain(r.body.tempPassword);
  });

  it('is limited to people you manage', async () => {
    const mine = await createUser('SUPERVISOR', a);
    const theirs = await createUser('SUPERVISOR', b);
    expect((await call(resetPassword, 'POST', '/x', { token: tok.subA, params: { id: theirs.id } })).status).toBe(404);
    expect((await call(resetPassword, 'POST', '/x', { token: tok.subA, params: { id: people.subA.id } })).status).toBe(404);
    expect((await call(resetPassword, 'POST', '/x', { token: tok.subA, params: { id: people.distA.id } })).status).toBe(404);
    expect((await call(resetPassword, 'POST', '/x', { token: tok.subA, params: { id: 'nope' } })).status).toBe(404);
    for (const k of ['supA', 'workerA', 'citizen']) expect((await call(resetPassword, 'POST', '/x', { token: tok[k], params: { id: mine.id } })).status, k).toBe(403);
    expect((await call(resetPassword, 'POST', '/x', { params: { id: mine.id } })).status).toBe(401);
    expect((await call(login, 'POST', '/x', { body: { identifier: mine.mobile, password: PASSWORD } })).status).toBe(200); // untouched
  });
});
