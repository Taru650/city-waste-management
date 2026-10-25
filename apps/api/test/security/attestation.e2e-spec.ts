import { NOTICE_VERSION } from '../../src/modules/privacy/notice';
import { generateKeyPairSync } from 'crypto';
import { Role } from '../../src/common/enums';
import { integrityNonce } from '../../src/modules/attestation/attestation.service';
import { CERT, fakePlayIntegrity, fakeToken } from '../fake-play-integrity';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, PASSWORD, TestCtx, tokenFor, uniqueMobile } from '../helpers';

const CITIZEN_PKG = 'org.citywaste.cwm_citizen';
const STAFF_PKG = 'org.citywaste.cwm_staff';
const newKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

type Fake = Awaited<ReturnType<typeof fakePlayIntegrity>>;

async function appWith(fake: Fake, mode: 'enforce' | 'monitor'): Promise<TestCtx> {
  const saved = { ...process.env };
  Object.assign(process.env, {
    PLAY_INTEGRITY_MODE: mode,
    PLAY_INTEGRITY_SERVICE_ACCOUNT_B64: fake.serviceAccountB64,
    PLAY_INTEGRITY_API_BASE: fake.apiBase,
    PLAY_INTEGRITY_CERT_SHA256: CERT,
    // The portal path: CAPTCHA is configured, so a request with neither proof is refused.
    CAPTCHA_SECRET: 'test-captcha-secret',
    CAPTCHA_VERIFY_URL: fake.siteverifyUrl,
  });
  try {
    return await createTestApp();
  } finally {
    process.env = saved;
  }
}

describe('Play Integrity attestation (M8)', () => {
  let fake: Fake;
  let ctx: TestCtx;
  let j: Jurisdiction;

  beforeAll(async () => {
    fake = await fakePlayIntegrity();
    ctx = await appWith(fake, 'enforce');
    j = await createJurisdiction(ctx.ds);
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const challenge = async (purpose: string) => (await ctx.http().post(api('/attestation/challenge')).send({ purpose }).expect(200)).body.challenge as string;
  const registration = (over: object = {}) => ({
    homeWardId: j.wards[0].id, consentNoticeVersion: NOTICE_VERSION, name: 'Asha Devi', mobile: uniqueMobile(), email: `a${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.in`,
    password: PASSWORD, ...over,
  });

  describe('citizen registration and password reset (the app has no CAPTCHA)', () => {
    it('issues signed, purpose-bound challenges', async () => {
      const res = await ctx.http().post(api('/attestation/challenge')).send({ purpose: 'register' }).expect(200);
      expect(res.body).toEqual({ enabled: true, challenge: expect.stringMatching(/^register\.\d+\./), expiresAt: expect.any(String) });
      await ctx.http().post(api('/attestation/challenge')).send({ purpose: 'login' }).expect(400);
    });

    it('a request with neither CAPTCHA nor Play Integrity is refused; the portal CAPTCHA path still works', async () => {
      await ctx.http().post(api('/auth/register')).send(registration()).expect(400);
      await ctx.http().post(api('/auth/register')).send(registration({ captchaToken: 'bot' })).expect(400);
      await ctx.http().post(api('/auth/register')).send(registration({ captchaToken: 'human' })).expect(201);
    });

    it('a genuine app on a basic-integrity phone registers; the same token cannot be used twice', async () => {
      const c = await challenge('register');
      const integrityToken = fakeToken(CITIZEN_PKG, integrityNonce(c), { device: ['MEETS_BASIC_INTEGRITY'] });
      await ctx.http().post(api('/auth/register')).send(registration({ attestationChallenge: c, integrityToken })).expect(201);
      const replay = await ctx.http().post(api('/auth/register')).send(registration({ attestationChallenge: c, integrityToken })).expect(403);
      expect(replay.body.message).not.toMatch(/nonce|replay/i); // reasons are logged, not shown
    });

    it.each([
      ['an unrecognised (re-signed or side-loaded) app', { app: 'UNRECOGNIZED_VERSION' }],
      ['a token minted for the Staff app', { pkg: STAFF_PKG }],
      ['an app signed with another certificate', { cert: 'attacker-cert' }],
      ['a phone that fails basic integrity', { device: [] }],
      ['a token older than 10 minutes', { ageMs: 11 * 60_000 }],
    ])('refuses %s', async (_label, o) => {
      const c = await challenge('register');
      await ctx.http().post(api('/auth/register')).send(registration({ attestationChallenge: c, integrityToken: fakeToken(CITIZEN_PKG, integrityNonce(c), o) })).expect(403);
    });

    it('refuses tampered, expired-looking and wrong-purpose challenges', async () => {
      const c = await challenge('register');
      const tampered = c.replace(/^register\.(\d+)/, (_m, exp) => `register.${Number(exp) + 3_600_000}`);
      await ctx.http().post(api('/auth/register')).send(registration({ attestationChallenge: tampered, integrityToken: fakeToken(CITIZEN_PKG, integrityNonce(tampered)) })).expect(400);
      const device = await challenge('device');
      await ctx.http().post(api('/auth/register')).send(registration({ attestationChallenge: device, integrityToken: fakeToken(CITIZEN_PKG, integrityNonce(device)) })).expect(400);
      await ctx.http().post(api('/auth/register')).send(registration({ attestationChallenge: 'garbage', integrityToken: 'fake.x' })).expect(400);
    });

    it('an app that could not get a token is refused while enforcing, without falling back to "no check"', async () => {
      await ctx.http().post(api('/auth/register')).send(registration({ attestationError: 'PLAY_SERVICES_NOT_FOUND' })).expect(403);
    });

    it('fails closed (503, retryable) when Google is unreachable', async () => {
      const c = await challenge('register');
      await ctx.http().post(api('/auth/register')).send(registration({ attestationChallenge: c, integrityToken: 'down' })).expect(503);
    });

    it('forgot-password accepts a Play Integrity proof', async () => {
      const c = await challenge('forgot-password');
      await ctx.http().post(api('/auth/forgot-password')).send({ identifier: 'nobody@example.in', attestationChallenge: c, integrityToken: fakeToken(CITIZEN_PKG, integrityNonce(c)) }).expect(202);
      await ctx.http().post(api('/auth/forgot-password')).send({ identifier: 'nobody@example.in' }).expect(400);
    });
  });

  describe('device signing keys', () => {
    const register = (token: string, body: object) => ctx.http().post(api('/devices')).set(bearer(token)).send({ platform: 'ANDROID', appVersion: '1.0.0', ...body });

    it('asks for attestation (428 + challenge), binds the verdict to the key, and stores it', async () => {
      const citizen = await createUser(ctx, Role.CITIZEN, j);
      const token = await tokenFor(ctx, citizen);
      const publicKey = newKey();
      const first = await register(token, { publicKey }).expect(428);
      const c = first.body.challenge as string;
      expect(c).toMatch(/^device\./);

      // A verdict obtained for a different key (e.g. a genuine phone vouching for an extracted key) is refused.
      await register(token, { publicKey, attestationChallenge: c, integrityToken: fakeToken(CITIZEN_PKG, integrityNonce(c, newKey())) }).expect(403);

      const c2 = (await register(token, { publicKey }).expect(428)).body.challenge as string;
      const ok = await register(token, { publicKey, attestationChallenge: c2, integrityToken: fakeToken(CITIZEN_PKG, integrityNonce(c2, publicKey)) }).expect(201);
      const [row] = await ctx.ds.query(`SELECT integrity_verdict, integrity_checked_at FROM devices WHERE id = $1`, [ok.body.id]);
      expect(row.integrity_verdict).toBe('MEETS_DEVICE_INTEGRITY');
      expect(row.integrity_checked_at).toBeTruthy();

      // Next login: recently attested key, no Google call, no 428.
      const decodes = fake.decodes.length;
      await register(token, { publicKey }).expect(201);
      expect(fake.decodes.length).toBe(decodes);

      // After 30 days the key must attest again.
      await ctx.ds.query(`UPDATE devices SET integrity_checked_at = now() - interval '31 days' WHERE id = $1`, [ok.body.id]);
      await register(token, { publicKey }).expect(428);
    });

    it('staff evidence needs device integrity: a basic-integrity phone is refused for a worker but fine for a citizen', async () => {
      const worker = await createUser(ctx, Role.WORKER, j);
      const token = await tokenFor(ctx, worker);
      const publicKey = newKey();
      let c = (await register(token, { publicKey }).expect(428)).body.challenge;
      await register(token, { publicKey, attestationChallenge: c, integrityToken: fakeToken(STAFF_PKG, integrityNonce(c, publicKey), { device: ['MEETS_BASIC_INTEGRITY'] }) }).expect(403);
      c = (await register(token, { publicKey }).expect(428)).body.challenge;
      await register(token, { publicKey, attestationChallenge: c, integrityToken: fakeToken(CITIZEN_PKG, integrityNonce(c, publicKey)) }).expect(403); // citizen-app token
      c = (await register(token, { publicKey }).expect(428)).body.challenge;
      await register(token, { publicKey, attestationChallenge: c, integrityToken: fakeToken(STAFF_PKG, integrityNonce(c, publicKey)) }).expect(201);
    });

    it('refuses iOS keys and apps that report they could not attest', async () => {
      const citizen = await createUser(ctx, Role.CITIZEN, j);
      const token = await tokenFor(ctx, citizen);
      await register(token, { publicKey: newKey(), platform: 'IOS' }).expect(403);
      await register(token, { publicKey: newKey(), attestationError: 'API_NOT_AVAILABLE' }).expect(403);
    });

    it('keys registered before enforcement cannot request uploads until they attest', async () => {
      const citizen = await createUser(ctx, Role.CITIZEN, j);
      const token = await tokenFor(ctx, citizen);
      const publicKey = newKey();
      const [d] = await ctx.ds.query(
        `INSERT INTO devices (user_id, public_key, key_fingerprint, platform) VALUES ($1, $2, md5(random()::text), 'ANDROID') RETURNING id`,
        [citizen.id, publicKey],
      );
      const res = await ctx.http().post(api('/media/upload-url')).set(bearer(token))
        .send({ deviceId: d.id, kind: 'PHOTO', contentType: 'image/jpeg', bytes: 1000, sha256: 'a'.repeat(64) }).expect(400);
      expect(res.body.message).toMatch(/register the device again/); // the apps re-register on this
    });
  });

  describe('monitor mode (rollout): verdicts are recorded, nobody is blocked', () => {
    let mon: TestCtx;
    beforeAll(async () => {
      mon = await appWith(fake, 'monitor');
    });
    afterAll(() => mon.app.close());

    it('records FAILED / UNVERIFIED instead of refusing', async () => {
      const citizen = await createUser(mon, Role.CITIZEN, j);
      const token = await tokenFor(mon, citizen);
      const reg = (body: object) => mon.http().post(api('/devices')).set(bearer(token)).send({ platform: 'ANDROID', ...body });
      const k1 = newKey();
      const c = (await reg({ publicKey: k1 }).expect(428)).body.challenge;
      const bad = await reg({ publicKey: k1, attestationChallenge: c, integrityToken: fakeToken(CITIZEN_PKG, integrityNonce(c, k1), { app: 'UNEVALUATED' }) }).expect(201);
      const noPlay = await reg({ publicKey: newKey(), attestationError: 'PLAY_STORE_NOT_FOUND' }).expect(201);
      const rows = await mon.ds.query(`SELECT id, integrity_verdict FROM devices WHERE id = ANY($1)`, [[bad.body.id, noPlay.body.id]]);
      expect(Object.fromEntries(rows.map((r: { id: string; integrity_verdict: string }) => [r.id, r.integrity_verdict]))).toEqual({
        [bad.body.id]: 'FAILED', [noPlay.body.id]: 'UNVERIFIED',
      });
      await mon.http().post(api('/auth/register')).send({
        homeWardId: j.wards[0].id, consentNoticeVersion: NOTICE_VERSION, name: 'No Play', mobile: uniqueMobile(), email: `np${Date.now()}@example.in`, password: PASSWORD, attestationError: 'PLAY_SERVICES_NOT_FOUND',
      }).expect(201);
    });
  });
});
