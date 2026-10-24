import { Role } from '../src/common/enums';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, login, TestCtx, tokenFor, uniqueMobile } from './helpers';

describe('Staff management and helpdesk (M1)', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let other: Jurisdiction;

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
    other = await createJurisdiction(ctx.ds);
  });
  afterAll(() => ctx.app.close());

  it('follows the hierarchy: Web Admin → District Admin → Sub Admin → Supervisor/Worker', async () => {
    const web = await tokenFor(ctx, await createUser(ctx, Role.WEB_ADMIN));
    const da = await ctx.http().post(api('/users')).set(bearer(web))
      .send({ role: 'DISTRICT_ADMIN', name: 'DM Office', mobile: uniqueMobile(), districtId: j.districtId }).expect(201);
    expect(da.body.tempPassword).toMatch(/^[A-Za-z0-9]{12}$/);

    const daUser = await createUser(ctx, Role.DISTRICT_ADMIN, j);
    const daToken = await tokenFor(ctx, daUser);
    await ctx.http().post(api('/users')).set(bearer(daToken))
      .send({ role: 'SUB_ADMIN', name: 'EO Nagar Nigam', mobile: uniqueMobile(), ulbId: j.ulbId }).expect(201);
    await ctx.http().post(api('/users')).set(bearer(daToken))
      .send({ role: 'SUB_ADMIN', name: 'Other district', mobile: uniqueMobile(), ulbId: other.ulbId }).expect(403);
    await ctx.http().post(api('/users')).set(bearer(daToken))
      .send({ role: 'SUPERVISOR', name: 'Skip level', mobile: uniqueMobile() }).expect(403);

    const sa = await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, j));
    // ulbId in the body is ignored: staff are always created in the Sub Admin's own ULB.
    const sup = await ctx.http().post(api('/users')).set(bearer(sa))
      .send({ role: 'SUPERVISOR', name: 'Supervisor One', mobile: uniqueMobile(), ulbId: other.ulbId }).expect(201);
    const [row] = await ctx.ds.query(`SELECT ulb_id, must_change_password FROM users WHERE id = $1`, [sup.body.id]);
    expect(row).toEqual({ ulb_id: j.ulbId, must_change_password: true });
    await ctx.http().post(api('/users')).set(bearer(sa))
      .send({ role: 'DISTRICT_ADMIN', name: 'Escalate', mobile: uniqueMobile(), districtId: j.districtId }).expect(403);
  });

  it('lists only staff inside the caller\'s jurisdiction', async () => {
    const sa = await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, j));
    const mine = await createUser(ctx, Role.WORKER, j);
    const theirs = await createUser(ctx, Role.WORKER, other);
    const res = await ctx.http().get(api('/users')).query({ role: 'WORKER' }).set(bearer(sa)).expect(200);
    const ids = res.body.map((u: { id: string }) => u.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it('disabling a user kills their live sessions immediately', async () => {
    const sa = await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, j));
    const w = await createUser(ctx, Role.WORKER, j);
    const session = await login(ctx, w);
    await ctx.http().patch(api(`/users/${w.id}/status`)).set(bearer(sa)).send({ status: 'DISABLED' }).expect(200);
    await ctx.http().get(api('/complaints')).set(bearer(session.accessToken)).expect(401);
    await ctx.http().post(api('/auth/refresh')).send({ refreshToken: session.refreshToken }).expect(401);
    await ctx.http().post(api('/auth/login')).send({ identifier: w.mobile, password: w.password }).expect(401);
  });

  it('Sub Admin helpdesk resets a citizen of their ULB to a temporary password', async () => {
    const sa = await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, j));
    const citizen = await createUser(ctx, Role.CITIZEN, j);
    const outsider = await createUser(ctx, Role.CITIZEN, other);
    const res = await ctx.http().post(api(`/users/${citizen.id}/reset-password`)).set(bearer(sa)).expect(201);
    const s = await login(ctx, { ...citizen, password: res.body.tempPassword });
    await ctx.http().get(api('/complaints')).set(bearer(s.accessToken)).expect(403); // must change first
    await ctx.http().post(api(`/users/${outsider.id}/reset-password`)).set(bearer(sa)).expect(404);
  });

  it('cannot manage self, peers or superiors', async () => {
    const saUser = await createUser(ctx, Role.SUB_ADMIN, j);
    const sa = await tokenFor(ctx, saUser);
    const peer = await createUser(ctx, Role.SUB_ADMIN, j);
    const boss = await createUser(ctx, Role.DISTRICT_ADMIN, j);
    for (const id of [saUser.id, peer.id, boss.id]) {
      await ctx.http().post(api(`/users/${id}/reset-password`)).set(bearer(sa)).expect(404);
      await ctx.http().patch(api(`/users/${id}/status`)).set(bearer(sa)).send({ status: 'DISABLED' }).expect(404);
    }
  });

  it('supervisors list active workers of their own ULB for assignment', async () => {
    const sup = await tokenFor(ctx, await createUser(ctx, Role.SUPERVISOR, j));
    const mine = await createUser(ctx, Role.WORKER, j);
    const theirs = await createUser(ctx, Role.WORKER, other);
    const res = await ctx.http().get(api('/users/workers')).set(bearer(sup)).expect(200);
    const ids = res.body.map((w: { id: string }) => w.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(res.body[0]).toEqual(expect.objectContaining({ openTasks: expect.any(Number) }));
    expect(JSON.stringify(res.body)).not.toContain(mine.mobile);
    // supervisors still cannot use the admin staff list
    await ctx.http().get(api('/users')).set(bearer(sup)).expect(403);
  });
});
