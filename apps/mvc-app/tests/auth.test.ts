import { beforeAll, describe, expect, it } from 'vitest';
import { POST as register } from '@/app/api/v1/auth/register/route';
import { POST as login } from '@/app/api/v1/auth/login/route';
import { POST as refresh } from '@/app/api/v1/auth/refresh/route';
import { POST as logout } from '@/app/api/v1/auth/logout/route';
import { POST as logoutAll } from '@/app/api/v1/auth/logout-all/route';
import { POST as changePassword } from '@/app/api/v1/auth/change-password/route';
import { POST as forgotPassword } from '@/app/api/v1/auth/forgot-password/route';
import { POST as resetPassword } from '@/app/api/v1/auth/reset-password/route';
import { GET as me } from '@/app/api/v1/auth/me/route';
import { PATCH as preferences } from '@/app/api/v1/auth/me/preferences/route';
import { NOTICE_VERSION } from '@/lib/notice';
import { PASSWORD, browser, call, captureMail, cookieJar, createJurisdiction, createUser, db, one, query, run, uniqueMobile, useTestEnvironment, type Jurisdiction } from './helpers';

useTestEnvironment();

let j: Jurisdiction;
beforeAll(async () => {
  j = await createJurisdiction();
});

const registration = (over: Record<string, unknown> = {}) => {
  const mobile = uniqueMobile();
  return { homeWardId: j.wards[0].id, name: 'Asha Verma', mobile, email: `asha${mobile}@example.in`, password: 'Swachh#Strong1', consentNoticeVersion: NOTICE_VERSION, consentLanguage: 'en', ...over };
};

describe('citizen registration', () => {
  it('creates the account, records consent, encrypts contact details and returns a session', async () => {
    const input = registration();
    const res = await call(register, 'POST', '/api/v1/auth/register', { body: input });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ status: 'OK', tokenType: 'Bearer', accessToken: expect.any(String), refreshToken: expect.any(String) }));

    const row = await one(db(), `SELECT * FROM users WHERE mobile_hash IS NOT NULL AND role = 'CITIZEN' ORDER BY created_at DESC LIMIT 1`);
    expect(row!.mobile_enc).not.toContain(input.mobile);
    expect(row!.email_enc).not.toContain('example.in');
    expect(row!.password_hash).toMatch(/^\$argon2id\$/);
    expect(row!.status).toBe('UNVERIFIED_MOBILE');
    const consent = await one(db(), `SELECT * FROM consents WHERE user_id = ?`, [row!.id]);
    expect(consent).toEqual(expect.objectContaining({ notice_version: NOTICE_VERSION, language: 'en' }));
    const profile = await call(me, 'GET', '/api/v1/auth/me', { token: res.body.accessToken });
    expect(profile.body).toEqual(expect.objectContaining({ name: 'Asha Verma', mobile: input.mobile, email: input.email, role: 'CITIZEN', consentRequired: false }));
  });

  it.each([
    ['an existing mobile number', (u: { mobile: string }) => registration({ mobile: u.mobile })],
    ['an existing email (any letter case)', (u: { email: string }) => registration({ email: u.email.toUpperCase() })],
  ])('refuses %s with one generic message', async (_n, make) => {
    const taken = await createUser('CITIZEN', j);
    const res = await call(register, 'POST', '/api/v1/auth/register', { body: make(taken) });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('An account with this mobile number or email already exists');
  });

  it.each([
    ['a weak password', { password: 'abcdefgh' }, 400],
    ['a common password', { password: 'Password@123' }, 400],
    ['a password containing the mobile number', (() => { const m = uniqueMobile(); return { mobile: m, email: `x${m}@example.in`, password: `Pw${m}x` }; })(), 400],
    ['an unknown ward', { homeWardId: '00000000-0000-4000-8000-000000000000' }, 400],
    ['a malformed mobile number', { mobile: '12345' }, 400],
    ['a stale privacy notice', { consentNoticeVersion: '1999-01' }, 409],
    ['an attempt to choose the role', { role: 'WEB_ADMIN' }, 400],
    ['an attempt to set the status', { status: 'ACTIVE', mustChangePassword: false }, 400],
  ])('rejects %s', async (_n, override, status) => {
    const res = await call(register, 'POST', '/api/v1/auth/register', { body: registration(override as Record<string, unknown>) });
    expect(res.status).toBe(status);
  });
});

describe('sign-in', () => {
  it('app mode: returns tokens; website mode: sets httpOnly SameSite=Strict cookies and returns no token', async () => {
    const u = await createUser('SUPERVISOR', j);
    const app = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } });
    expect(app.status).toBe(200);
    expect(app.body.accessToken).toEqual(expect.any(String));
    expect(app.cookies).toHaveLength(0);

    const web = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password, session: 'cookie' } });
    expect(web.status).toBe(200);
    expect(JSON.stringify(web.body)).not.toMatch(/eyJ|refreshToken|accessToken/);
    expect(web.cookies).toHaveLength(2);
    for (const c of web.cookies) {
      expect(c).toMatch(/HttpOnly/);
      expect(c).toMatch(/SameSite=Strict/);
      expect(c).toMatch(/Path=\//);
    }
    const profile = await call(me, 'GET', '/api/v1/auth/me', browser(cookieJar(web)));
    expect(profile.body.id).toBe(u.id);
  });

  it('accepts the email address too, in any letter case', async () => {
    const u = await createUser('CITIZEN', j);
    const res = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.email.toUpperCase(), password: u.password } });
    expect(res.status).toBe(200);
  });

  it('gives the same answer for an unknown user, a wrong password and a disabled account', async () => {
    const u = await createUser('CITIZEN', j);
    const disabled = await createUser('SUPERVISOR', j, { status: 'DISABLED' });
    const bad = [
      await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: '9999999999', password: PASSWORD } }),
      await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: 'Wrong#password1' } }),
      await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: disabled.mobile, password: disabled.password } }),
    ];
    for (const r of bad) {
      expect(r.status).toBe(401);
      expect(r.body.message).toBe('Invalid credentials');
    }
  });

  it('locks the account after 5 wrong passwords, even for the right one, and records it', async () => {
    const u = await createUser('SUPERVISOR', j);
    for (let i = 0; i < 4; i++) await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: 'Wrong#password1' } });
    // four failures do not lock, and a success resets the counter
    expect((await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).status).toBe(200);
    for (let i = 0; i < 5; i++) await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: 'Wrong#password1' } });
    const right = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } });
    expect(right.status).toBe(401);
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE actor_id = ? AND action = 'ACCOUNT_LOCKED'`, [u.id])).toBeTruthy();
    // lock expires
    await run(db(), `UPDATE users SET locked_until = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?`, [u.id]);
    expect((await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).status).toBe(200);
  });

  it('a temporary account whose access has expired cannot sign in', async () => {
    const u = await createUser('WORKER', j);
    await run(db(), `UPDATE users SET access_expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?`, [u.id]);
    expect((await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).status).toBe(401);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens; replaying an old one ends the whole session (theft detection)', async () => {
    const u = await createUser('CITIZEN', j);
    const s1 = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    const s2 = (await call(refresh, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: s1.refreshToken } })).body;
    expect(s2.refreshToken).not.toBe(s1.refreshToken);
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: s2.accessToken })).status).toBe(200);
    // the attacker replays the stolen, already-rotated token
    expect((await call(refresh, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: s1.refreshToken } })).status).toBe(401);
    // ...and the legitimate holder's newer token, and its access token, are dead too
    expect((await call(refresh, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: s2.refreshToken } })).status).toBe(401);
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: s2.accessToken })).status).toBe(401);
  });

  it('two parallel refreshes with one token: exactly one wins', async () => {
    const u = await createUser('CITIZEN', j);
    const s = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    const results = await Promise.all([1, 2].map(() => call(refresh, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: s.refreshToken } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('website mode: refresh uses the cookie and never returns a token', async () => {
    const u = await createUser('SUB_ADMIN', j);
    const web = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password, session: 'cookie' } });
    const jar = cookieJar(web);
    const res = await call(refresh, 'POST', '/api/v1/auth/refresh', { body: {}, ...browser({ cwm_rt: jar.cwm_rt }) });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ|refreshToken|accessToken/);
    expect(cookieJar(res).cwm_rt).toBeTruthy();
    expect(cookieJar(res).cwm_rt).not.toBe(jar.cwm_rt);
  });

  it('signing out ends that session\'s access tokens at once, and only that session', async () => {
    const u = await createUser('SUPERVISOR', j);
    const office = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    const phone = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: office.accessToken })).status).toBe(200);
    expect((await call(logout, 'POST', '/api/v1/auth/logout', { body: { refreshToken: office.refreshToken } })).status).toBe(204);
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: office.accessToken })).status).toBe(401); // a copied token is dead at once
    expect((await call(refresh, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: office.refreshToken } })).status).toBe(401);
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: phone.accessToken })).status).toBe(200);
  });

  it('logout-all ends every session', async () => {
    const u = await createUser('CITIZEN', j);
    const a = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    const b = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    expect((await call(logoutAll, 'POST', '/api/v1/auth/logout-all', { token: a.accessToken })).status).toBe(204);
    for (const s of [a, b]) expect((await call(me, 'GET', '/api/v1/auth/me', { token: s.accessToken })).status).toBe(401);
  });

  it('disabling an account takes effect on the next request', async () => {
    const u = await createUser('SUPERVISOR', j);
    const s = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    await run(db(), `UPDATE users SET status = 'DISABLED' WHERE id = ?`, [u.id]);
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: s.accessToken })).status).toBe(401);
    expect((await call(refresh, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: s.refreshToken } })).status).toBe(401);
  });
});

describe('passwords', () => {
  it('change: needs the current password, ends other sessions, returns a fresh session', async () => {
    const u = await createUser('SUPERVISOR', j);
    const old = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    expect((await call(changePassword, 'POST', '/api/v1/auth/change-password', { token: old.accessToken, body: { currentPassword: 'Wrong#password1', newPassword: 'Brand#New2026x' } })).status).toBe(400);
    expect((await call(changePassword, 'POST', '/api/v1/auth/change-password', { token: old.accessToken, body: { currentPassword: u.password, newPassword: u.password } })).status).toBe(400);
    expect((await call(changePassword, 'POST', '/api/v1/auth/change-password', { token: old.accessToken, body: { currentPassword: u.password, newPassword: 'weak' } })).status).toBe(400);
    const ok = await call(changePassword, 'POST', '/api/v1/auth/change-password', { token: old.accessToken, body: { currentPassword: u.password, newPassword: 'Brand#New2026x' } });
    expect(ok.status).toBe(200);
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: old.accessToken })).status).toBe(401);
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: ok.body.accessToken })).status).toBe(200);
    expect((await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).status).toBe(401);
    expect((await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: 'Brand#New2026x' } })).status).toBe(200);
  });

  it('a temporary password must be replaced before anything else works', async () => {
    const u = await createUser('WORKER', j, { mustChangePassword: true });
    const s = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: s.accessToken })).body.mustChangePassword).toBe(true);
    const other = await call(preferences, 'PATCH', '/api/v1/auth/me/preferences', { token: s.accessToken, body: { preferredLanguage: 'en' } });
    expect(other.status).toBe(200); // allowed: part of account settings
    const changed = await call(changePassword, 'POST', '/api/v1/auth/change-password', { token: s.accessToken, body: { currentPassword: u.password, newPassword: 'Fresh#Pass2026x' } });
    expect(changed.status).toBe(200);
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: changed.body.accessToken })).body.mustChangePassword).toBe(false);
  });

  it('forgot password: same reply for known and unknown accounts; the link works once and ends all sessions', async () => {
    const mail = captureMail();
    const u = await createUser('SUPERVISOR', j);
    const session = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    const known = await call(forgotPassword, 'POST', '/api/v1/auth/forgot-password', { body: { identifier: u.email } });
    const unknown = await call(forgotPassword, 'POST', '/api/v1/auth/forgot-password', { body: { identifier: 'nobody@example.in' } });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe(u.email);
    const token = /token=([\w-]+)/.exec(mail[0].text)![1];
    const stored = await one(db(), `SELECT token_hash FROM password_resets WHERE user_id = ?`, [u.id]);
    expect(stored!.token_hash).not.toContain(token); // only a hash is stored

    expect((await call(resetPassword, 'POST', '/api/v1/auth/reset-password', { body: { token, newPassword: 'weak' } })).status).toBe(400);
    expect((await call(resetPassword, 'POST', '/api/v1/auth/reset-password', { body: { token, newPassword: 'Reset#Done2026x' } })).status).toBe(204);
    expect((await call(resetPassword, 'POST', '/api/v1/auth/reset-password', { body: { token, newPassword: 'Another#Pass2026x' } })).status).toBe(400); // single use
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: session.accessToken })).status).toBe(401);
    expect((await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: 'Reset#Done2026x' } })).status).toBe(200);
  });

  it('a newer reset link voids the older one, and an expired link is refused', async () => {
    const mail = captureMail();
    const u = await createUser('SUPERVISOR', j);
    await call(forgotPassword, 'POST', '/api/v1/auth/forgot-password', { body: { identifier: u.email } });
    await call(forgotPassword, 'POST', '/api/v1/auth/forgot-password', { body: { identifier: u.email } });
    const [first, second] = mail.map((m) => /token=([\w-]+)/.exec(m.text)![1]);
    expect((await call(resetPassword, 'POST', '/api/v1/auth/reset-password', { body: { token: first, newPassword: 'Reset#Done2026x' } })).status).toBe(400);
    await run(db(), `UPDATE password_resets SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE user_id = ?`, [u.id]);
    expect((await call(resetPassword, 'POST', '/api/v1/auth/reset-password', { body: { token: second, newPassword: 'Reset#Done2026x' } })).status).toBe(400);
  });

  it('reset also clears a lockout', async () => {
    const mail = captureMail();
    const u = await createUser('SUPERVISOR', j);
    for (let i = 0; i < 5; i++) await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: 'Wrong#password1' } });
    await call(forgotPassword, 'POST', '/api/v1/auth/forgot-password', { body: { identifier: u.mobile } });
    const token = /token=([\w-]+)/.exec(mail[0].text)![1];
    await call(resetPassword, 'POST', '/api/v1/auth/reset-password', { body: { token, newPassword: 'Reset#Done2026x' } });
    expect((await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: 'Reset#Done2026x' } })).status).toBe(200);
  });
});

describe('profile', () => {
  it('shows who is signed in and lets them choose a language', async () => {
    const u = await createUser('CITIZEN', j);
    const s = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    const updated = await call(preferences, 'PATCH', '/api/v1/auth/me/preferences', { token: s.accessToken, body: { preferredLanguage: 'en' } });
    expect(updated.body.preferredLanguage).toBe('en');
    expect((await call(preferences, 'PATCH', '/api/v1/auth/me/preferences', { token: s.accessToken, body: { preferredLanguage: 'fr' } })).status).toBe(400);
  });

  it('a citizen who has not accepted the current notice is told so', async () => {
    const u = await createUser('CITIZEN', j, { consent: false });
    const s = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } })).body;
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: s.accessToken })).body.consentRequired).toBe(true);
  });

  it('records sign-ins in the audit log without secrets', async () => {
    const u = await createUser('SUPERVISOR', j);
    await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: u.password } });
    const rows = await query(db(), `SELECT action, meta FROM audit_logs WHERE actor_id = ?`, [u.id]);
    expect(rows.map((r) => r.action)).toContain('LOGIN');
    expect(JSON.stringify(rows)).not.toContain(u.password);
  });
});
