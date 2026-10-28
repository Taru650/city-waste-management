import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as refreshRoute } from '@/app/api/v1/auth/refresh/route';
import { GET as meRoute } from '@/app/api/v1/auth/me/route';
import { GET as noticeRoute } from '@/app/api/v1/privacy/notice/route';
import { POST as consentRoute } from '@/app/api/v1/privacy/consent/route';
import { GET as myDataRoute } from '@/app/api/v1/privacy/my-data/route';
import { PATCH as profileRoute } from '@/app/api/v1/privacy/profile/route';
import { POST as erasureRoute } from '@/app/api/v1/privacy/erasure/route';
import { GET as complaintsRoute, POST as fileRoute } from '@/app/api/v1/complaints/route';
import { GET as complaintRoute } from '@/app/api/v1/complaints/[id]/route';
import { GET as notificationsRoute } from '@/app/api/v1/notifications/route';
import { DELETE as deleteTokenRoute, POST as addTokenRoute } from '@/app/api/v1/notifications/push-tokens/route';
import { POST as uploadUrlRoute } from '@/app/api/v1/media/upload-url/route';
import { GET as devicesRoute } from '@/app/api/v1/devices/route';
import { resetConfigForTests } from '@/config/env';
import { NOTICE_VERSION } from '@/lib/notice';
import { PrivacyService } from '@/services/PrivacyService';
import { PASSWORD, call, createJurisdiction, createUser, db, loginAs, one, query, run, setupTestEnvironment, uniqueMobile, type Jurisdiction } from './helpers';
import { makeDevice, makeJpeg, uploadMedia } from './media-helpers';

setupTestEnvironment();

let j: Jurisdiction;
let typeId: string;

beforeAll(async () => {
  j = await createJurisdiction();
  typeId = (await one(db(), `SELECT id FROM complaint_types WHERE active ORDER BY sort_order LIMIT 1`))!.id;
});
afterEach(() => {
  delete process.env.GRIEVANCE_OFFICER_NAME;
  delete process.env.GRIEVANCE_OFFICER_EMAIL;
  resetConfigForTests();
});

const registration = (over: Record<string, unknown> = {}) => {
  const mobile = uniqueMobile();
  return { homeWardId: j.wards[0].id, name: 'Asha Devi', mobile, email: `p${mobile}@example.in`, password: PASSWORD, consentNoticeVersion: NOTICE_VERSION, consentLanguage: 'hi', ...over };
};
async function register(over: Record<string, unknown> = {}) {
  const body = registration(over);
  const res = await call(registerRoute, 'POST', '/x', { body });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const me = (await call(meRoute, 'GET', '/x', { token: res.body.accessToken })).body;
  return { ...body, id: me.id as string, token: res.body.accessToken as string, refresh: res.body.refreshToken as string };
}
async function fileComplaint(c: { token: string }) {
  const at = j.wards[0].center;
  const device = await makeDevice(c.token);
  const up = await uploadMedia(c.token, device, await makeJpeg(64, 48), { lat: at.lat, lng: at.lng });
  const res = await call(fileRoute, 'POST', '/x', { token: c.token, body: { typeId, lat: at.lat, lng: at.lng, description: 'Garbage near my house no. 12', mediaIds: [up.mediaId] } });
  expect(res.status).toBe(201);
  return res.body;
}
const consents = (id: string) => query(db(), `SELECT purpose, notice_version, language, withdrawn_at FROM consents WHERE user_id = ?`, [id]);

describe('the privacy notice', () => {
  it('is public, in Hindi and English with the same sections, and names the grievance officer', async () => {
    process.env.GRIEVANCE_OFFICER_NAME = 'Grievance Officer, Nagar Nigam';
    process.env.GRIEVANCE_OFFICER_EMAIL = 'grievance@example.gov.in';
    resetConfigForTests();
    const res = await call(noticeRoute, 'GET', '/x');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(NOTICE_VERSION);
    expect(res.body.grievanceOfficer).toEqual({ name: 'Grievance Officer, Nagar Nigam', email: 'grievance@example.gov.in', phone: '' });
    expect(res.body.hi.sections).toHaveLength(res.body.en.sections.length);
    expect(res.body.hi.sections.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(res.body.en)).toMatch(/Data Protection Board/);
    expect(JSON.stringify(res.body.hi)).toMatch(/[ऀ-ॿ]/);
  });
});

describe('consent', () => {
  it('no account without consent to the current notice; consent is stored with its version and language', async () => {
    const { consentNoticeVersion, ...missing } = registration();
    void consentNoticeVersion;
    expect((await call(registerRoute, 'POST', '/x', { body: missing })).status).toBe(400);
    const stale = await call(registerRoute, 'POST', '/x', { body: registration({ consentNoticeVersion: '2020-01-01' }) });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/notice has changed/);
    const c = await register({ consentLanguage: 'en' });
    expect(await consents(c.id)).toEqual([{ purpose: 'GRIEVANCE_SERVICE', notice_version: NOTICE_VERSION, language: 'en', withdrawn_at: null }]);
    expect((await call(meRoute, 'GET', '/x', { token: c.token })).body.consentRequired).toBe(false);
  });

  it('an account without a current consent is asked again, and accepting is recorded once', async () => {
    const old = await createUser('CITIZEN', j, { consent: false });
    const token = await loginAs(old);
    expect((await call(meRoute, 'GET', '/x', { token })).body.consentRequired).toBe(true);
    expect((await call(consentRoute, 'POST', '/x', { token, body: { noticeVersion: 'old', language: 'en' } })).status).toBe(409);
    expect((await call(consentRoute, 'POST', '/x', { token, body: { noticeVersion: NOTICE_VERSION, language: 'en' } })).status).toBe(200);
    expect((await call(consentRoute, 'POST', '/x', { token, body: { noticeVersion: NOTICE_VERSION, language: 'hi' } })).status).toBe(200); // again: nothing new
    expect(await consents(old.id)).toHaveLength(1);
    expect((await call(meRoute, 'GET', '/x', { token })).body.consentRequired).toBe(false);
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE actor_id = ? AND action = 'CONSENT_GIVEN'`, [old.id])).toBeTruthy();
    for (const body of [{ language: 'en' }, { noticeVersion: NOTICE_VERSION, language: 'fr' }, { noticeVersion: NOTICE_VERSION, language: 'en', extra: 1 }]) {
      expect((await call(consentRoute, 'POST', '/x', { token, body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('staff do not consent (citizens only)', async () => {
    const staff = await loginAs(await createUser('WORKER', j));
    expect((await call(meRoute, 'GET', '/x', { token: staff })).body.consentRequired).toBe(false);
    expect((await call(consentRoute, 'POST', '/x', { token: staff, body: { noticeVersion: NOTICE_VERSION, language: 'en' } })).status).toBe(403);
  });
});

describe('the consent gate, enforced on the server', () => {
  it('until a citizen accepts the current notice only account and privacy functions work', async () => {
    const c = await createUser('CITIZEN', j, { consent: false });
    const token = await loginAs(c);
    const refused = await call(complaintsRoute, 'GET', '/x', { token });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('CONSENT_REQUIRED');
    expect((await call(notificationsRoute, 'GET', '/x', { token })).status).toBe(403);
    expect((await call(uploadUrlRoute, 'POST', '/x', { token, body: {} })).status).toBe(403); // refused before any validation
    expect((await call(addTokenRoute, 'POST', '/x', { token, body: { token: 'f'.repeat(40), platform: 'ANDROID' } })).status).toBe(403);
    // still reachable
    expect((await call(meRoute, 'GET', '/x', { token })).status).toBe(200);
    expect((await call(devicesRoute, 'GET', '/x', { token })).status).toBe(200);
    expect((await call(deleteTokenRoute, 'DELETE', '/x', { token, body: { token: 'f'.repeat(40) } })).status).toBe(204);
    expect((await call(myDataRoute, 'GET', '/x', { token })).status).toBe(200);
    expect((await call(profileRoute, 'PATCH', '/x', { token, body: { name: 'Asha Devi' } })).status).toBe(204);
    expect((await call(consentRoute, 'POST', '/x', { token, body: { noticeVersion: NOTICE_VERSION, language: 'en' } })).status).toBe(200);
    expect((await call(complaintsRoute, 'GET', '/x', { token })).status).toBe(200); // the same token, at once
  });

  it('applies mid-session when consent is withdrawn, and never to staff', async () => {
    const c = await register();
    expect((await call(complaintsRoute, 'GET', '/x', { token: c.token })).status).toBe(200);
    await run(db(), `UPDATE consents SET withdrawn_at = NOW(3) WHERE user_id = ?`, [c.id]);
    const res = await call(complaintsRoute, 'GET', '/x', { token: c.token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CONSENT_REQUIRED');
    const staff = await loginAs(await createUser('SUPERVISOR', j));
    expect((await call(complaintsRoute, 'GET', '/x', { token: staff })).status).toBe(200);
  });
});

describe('right of access', () => {
  it('returns everything about the citizen, decrypted, and nothing about anyone else', async () => {
    const a = await register();
    const b = await register();
    const mine = await fileComplaint(a);
    const theirs = await fileComplaint(b);
    await call(addTokenRoute, 'POST', '/x', { token: a.token, body: { token: 'fcm-export-token-0000000000000001', platform: 'ANDROID' } });
    const res = await call(myDataRoute, 'GET', '/x', { token: a.token });
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d.profile).toEqual(expect.objectContaining({ name: 'Asha Devi', mobile: a.mobile, email: a.email, language: 'hi' }));
    expect(d.profile.home).toEqual({ district: expect.any(String), ulb: expect.any(String), ward: 1 });
    expect(d.consents).toHaveLength(1);
    expect(d.complaints.map((c: { complaintNo: string }) => c.complaintNo)).toEqual([mine.complaintNo]);
    expect(d.complaints[0].history.map((h: { action: string }) => h.action)).toEqual(['CREATE']); // the ward has no supervisor, so it was not routed
    expect(d.complaints[0].yourMedia).toHaveLength(1);
    expect(d.complaints[0].yourMedia[0]).toEqual(expect.objectContaining({ kind: 'PHOTO', stage: 'COMPLAINT' }));
    expect(d.devices.length).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(d);
    expect(text).not.toContain(theirs.complaintNo);
    expect(text).not.toContain(b.mobile);
    expect(text).not.toContain(b.email);
    expect(text).not.toMatch(/argon2|password_hash|public_?key|token_version/i);
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE actor_id = ? AND action = 'DATA_EXPORTED'`, [a.id])).toBeTruthy();
  });

  it('is for citizens only', async () => {
    const staff = await loginAs(await createUser('SUPERVISOR', j));
    expect((await call(myDataRoute, 'GET', '/x', { token: staff })).status).toBe(403);
    expect((await call(myDataRoute, 'GET', '/x')).status).toBe(401);
  });
});

describe('right of correction', () => {
  it('corrects name, guardian name and email; refuses an email another account uses; the mobile number cannot be changed', async () => {
    const a = await register({ guardianName: 'Ram Lal' });
    const b = await register();
    const patch = (body: unknown) => call(profileRoute, 'PATCH', '/x', { token: a.token, body });
    expect((await patch({ name: 'Asha Kumari', guardianName: null })).status).toBe(204);
    expect((await patch({ email: b.email })).status).toBe(409);
    expect((await patch({ email: b.email.toUpperCase() })).status).toBe(409);
    expect((await patch({ mobile: '9000000000' })).status).toBe(400);
    expect((await patch({ role: 'WEB_ADMIN' })).status).toBe(400);
    expect((await patch({ name: '<b>x</b>' })).status).toBe(400);
    expect((await patch({ email: `new${a.email}` })).status).toBe(204);
    const me = (await call(meRoute, 'GET', '/x', { token: a.token })).body;
    expect(me).toEqual(expect.objectContaining({ name: 'Asha Kumari', guardianName: null, email: `new${a.email}`.toLowerCase(), mobile: a.mobile }));
    // the new email works for sign-in and the old one no longer does
    expect((await call(loginRoute, 'POST', '/x', { body: { identifier: `new${a.email}`, password: PASSWORD } })).status).toBe(200);
    expect((await call(loginRoute, 'POST', '/x', { body: { identifier: a.email, password: PASSWORD } })).status).toBe(401);
    expect((await patch({})).status).toBe(204); // nothing to change is fine
  });
});

describe('right of erasure', () => {
  it('needs the password; removes identity and contact details at once, ends every session, keeps complaints anonymously', async () => {
    const a = await register();
    const c = await fileComplaint(a);
    await run(db(), `INSERT INTO feedback (complaint_id, citizen_id, rating, remark) VALUES (?,?,4,'My neighbour Mr Sharma dumps here')`, [c.id, a.id]);
    await call(addTokenRoute, 'POST', '/x', { token: a.token, body: { token: 'fcm-token-for-erasure-test-000001', platform: 'ANDROID' } });

    expect((await call(erasureRoute, 'POST', '/x', { token: a.token, body: { password: 'wrong-password' } })).status).toBe(400);
    expect((await call(meRoute, 'GET', '/x', { token: a.token })).status).toBe(200); // a wrong password changes nothing
    expect((await call(erasureRoute, 'POST', '/x', { token: a.token, body: { password: a.password, extra: 1 } })).status).toBe(400);
    expect((await call(erasureRoute, 'POST', '/x', { token: a.token, body: { password: a.password } })).status).toBe(204);

    expect((await call(meRoute, 'GET', '/x', { token: a.token })).status).toBe(401);
    expect((await call(refreshRoute, 'POST', '/x', { body: { refreshToken: a.refresh } })).status).toBe(401);
    expect((await call(loginRoute, 'POST', '/x', { body: { identifier: a.mobile, password: a.password } })).status).toBe(401);
    expect((await call(loginRoute, 'POST', '/x', { body: { identifier: a.email, password: a.password } })).status).toBe(401);

    const u = (await one(db(), `SELECT name, guardian_name, mobile_enc, mobile_hash, email_enc, email_hash, status, erased_at FROM users WHERE id = ?`, [a.id]))!;
    expect(u).toEqual(expect.objectContaining({ name: 'Deleted user', guardian_name: null, mobile_enc: null, mobile_hash: null, email_enc: null, email_hash: null, status: 'DISABLED' }));
    expect(u.erased_at).toBeTruthy();
    const left = (await one(
      db(),
      `SELECT (SELECT COUNT(*) FROM notifications WHERE user_id = ?) AS notes,
              (SELECT COUNT(*) FROM push_tokens WHERE user_id = ?) AS push,
              (SELECT COUNT(*) FROM devices WHERE user_id = ? AND revoked_at IS NULL) AS devices,
              (SELECT COUNT(*) FROM consents WHERE user_id = ? AND withdrawn_at IS NULL) AS consents,
              (SELECT COUNT(*) FROM complaints WHERE citizen_id = ?) AS complaints,
              (SELECT remark FROM feedback WHERE complaint_id = ?) AS remark`,
      [a.id, a.id, a.id, a.id, a.id, c.id],
    ))!;
    expect({ ...left, notes: Number(left.notes), push: Number(left.push), devices: Number(left.devices), consents: Number(left.consents), complaints: Number(left.complaints) })
      .toEqual({ notes: 0, push: 0, devices: 0, consents: 0, complaints: 1, remark: null });
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE entity_id = ? AND action = 'ACCOUNT_ERASED'`, [a.id])).toBeTruthy();

    // the complaint still works for the ULB, without the citizen's identity
    const sub = await loginAs(await createUser('SUB_ADMIN', j));
    const shown = await call(complaintRoute, 'GET', '/x', { token: sub, params: { id: c.id } });
    expect(shown.status).toBe(200);
    expect(JSON.stringify(shown.body)).not.toMatch(new RegExp(`${a.mobile}|${a.email}|Asha Devi`));
    // and the same mobile number and email can open a new account
    expect((await call(registerRoute, 'POST', '/x', { body: registration({ mobile: a.mobile, email: a.email }) })).status).toBe(201);
    // erasing twice is refused: the password no longer exists
    expect((await call(erasureRoute, 'POST', '/x', { token: a.token, body: { password: a.password } })).status).toBe(401);
  });

  it('staff accounts are closed by their administrator, not by self-service', async () => {
    const w = await createUser('WORKER', j);
    expect((await call(erasureRoute, 'POST', '/x', { token: await loginAs(w), body: { password: w.password } })).status).toBe(403);
    expect((await one(db(), `SELECT status FROM users WHERE id = ?`, [w.id]))!.status).toBe('ACTIVE');
  });
});

describe('defence in depth', () => {
  it('the service itself refuses staff, even if a route were ever opened to them', async () => {
    const w = await createUser('WORKER', j);
    const staff = { id: w.id, role: 'WORKER' as const, districtId: j.districtId, ulbId: j.ulbId, areaId: null, mustChangePassword: false, consentRequired: false, sessionId: 's', via: 'bearer' as const };
    await expect(PrivacyService.erase(staff, w.password, null)).rejects.toMatchObject({ status: 403 });
    await expect(PrivacyService.export(staff)).rejects.toMatchObject({ status: 403 });
    await expect(PrivacyService.correct(staff, { name: 'Someone Else' })).rejects.toMatchObject({ status: 403 });
    await expect(PrivacyService.consent(staff, { noticeVersion: NOTICE_VERSION, language: 'en' })).rejects.toMatchObject({ status: 403 });
    expect((await one(db(), `SELECT status, name FROM users WHERE id = ?`, [w.id]))).toEqual({ status: 'ACTIVE', name: expect.not.stringMatching(/Deleted user|Someone Else/) });
  });
});

describe('append-only history', () => {
  it('feedback can only lose its remark, and the database says so', async (ctx) => {
    const guard = await one(db(), `SELECT 1 AS x FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = 'feedback_guard_update'`);
    if (!guard) ctx.skip(); // the database-level guard needs log_bin_trust_function_creators=1 (see README); the app also enforces it in code
    const a = await register();
    const c = await fileComplaint(a);
    await run(db(), `INSERT INTO feedback (id, complaint_id, citizen_id, rating, remark) VALUES (UUID(), ?, ?, 2, 'x')`, [c.id, a.id]);
    const f = (await one(db(), `SELECT id FROM feedback WHERE complaint_id = ?`, [c.id]))!;
    await expect(run(db(), `UPDATE feedback SET rating = 5 WHERE id = ?`, [f.id])).rejects.toThrow(/append-only/);
    await expect(run(db(), `UPDATE feedback SET rating = 5, remark = NULL WHERE id = ?`, [f.id])).rejects.toThrow(/append-only/);
    await expect(run(db(), `DELETE FROM feedback WHERE id = ?`, [f.id])).rejects.toThrow(/append-only/);
    await run(db(), `UPDATE feedback SET remark = NULL WHERE id = ?`, [f.id]);
  });

  it('the complaint history and the audit log cannot be edited or deleted', async (ctx) => {
    const guard = await one(db(), `SELECT 1 AS x FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = 'complaint_events_no_update'`);
    if (!guard) ctx.skip();
    const a = await register();
    const c = await fileComplaint(a);
    await expect(run(db(), `UPDATE complaint_events SET remark = 'edited' WHERE complaint_id = ?`, [c.id])).rejects.toThrow(/append-only/);
    await expect(run(db(), `DELETE FROM complaint_events WHERE complaint_id = ?`, [c.id])).rejects.toThrow(/append-only/);
    await expect(run(db(), `UPDATE audit_logs SET action = 'X' WHERE actor_id = ?`, [a.id])).rejects.toThrow(/append-only/);
    await expect(run(db(), `DELETE FROM audit_logs WHERE actor_id = ?`, [a.id])).rejects.toThrow(/append-only/);
  });
});

describe('retention', () => {
  it('deletes old read notifications, old unread ones, spent sessions and spent reset links; keeps the rest', async () => {
    const u = await createUser('CITIZEN', j);
    await loginAs(u);
    await run(
      db(),
      `INSERT INTO notifications (user_id, type, title_en, title_hi, body_en, body_hi, read_at, created_at) VALUES
         (?, 'T', 'old read', 'x', 'b', 'b', DATE_SUB(NOW(3), INTERVAL 200 DAY), DATE_SUB(NOW(3), INTERVAL 200 DAY)),
         (?, 'T', 'recent', 'x', 'b', 'b', NOW(3), DATE_SUB(NOW(3), INTERVAL 10 DAY)),
         (?, 'T', 'recent unread', 'x', 'b', 'b', NULL, DATE_SUB(NOW(3), INTERVAL 300 DAY)),
         (?, 'T', 'old unread', 'x', 'b', 'b', NULL, DATE_SUB(NOW(3), INTERVAL 400 DAY))`,
      [u.id, u.id, u.id, u.id],
    );
    await run(db(), `UPDATE refresh_tokens SET revoked_at = DATE_SUB(NOW(3), INTERVAL 40 DAY), created_at = DATE_SUB(NOW(3), INTERVAL 40 DAY) WHERE user_id = ?`, [u.id]);
    await run(db(), `INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (UUID(), ?, SHA2(UUID(), 256), DATE_SUB(NOW(3), INTERVAL 3 DAY), DATE_SUB(NOW(3), INTERVAL 3 DAY), DATE_SUB(NOW(3), INTERVAL 4 DAY))`, [u.id]);
    await run(db(), `INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (UUID(), ?, SHA2(UUID(), 256), DATE_ADD(NOW(3), INTERVAL 10 MINUTE))`, [u.id]);

    const result = await PrivacyService.purge();
    expect(result.notifications).toBeGreaterThanOrEqual(2);
    expect((await query<{ title_en: string }>(db(), `SELECT title_en FROM notifications WHERE user_id = ? ORDER BY title_en`, [u.id])).map((r) => r.title_en)).toEqual(['recent', 'recent unread']);
    expect(await query(db(), `SELECT 1 FROM refresh_tokens WHERE user_id = ?`, [u.id])).toHaveLength(0);
    expect(await query(db(), `SELECT 1 FROM password_resets WHERE user_id = ?`, [u.id])).toHaveLength(1); // the live link stays
    expect(await PrivacyService.purge()).toEqual({ notifications: expect.any(Number), sessions: 0, passwordResets: 0 });
  });
});
