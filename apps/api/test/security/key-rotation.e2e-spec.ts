import { Role } from '../../src/common/enums';
import { rotatePiiKeys } from '../../src/database/rotate-pii-keys';
import { NOTICE_VERSION } from '../../src/modules/privacy/notice';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, login, PASSWORD, TestCtx, TestUser } from '../helpers';

/**
 * PII key rotation (incident response): new keys deployed with the old ones as *_PREVIOUS, the job
 * moves every stored value, then the old keys are removed. Each stage runs the real API.
 */
const b64 = (n: number) => Buffer.alloc(32, n).toString('base64');
const KEYS = ['PII_ENCRYPTION_KEY', 'PII_HASH_KEY', 'PII_ENCRYPTION_KEY_PREVIOUS', 'PII_HASH_KEY_PREVIOUS'] as const;

describe('PII key rotation (M10)', () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const oldEnc = process.env.PII_ENCRYPTION_KEY!;
  const oldHash = process.env.PII_HASH_KEY!;
  const withKeys = async (keys: Partial<Record<(typeof KEYS)[number], string>>) => {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, keys);
    return createTestApp();
  };
  let citizen: TestUser;
  let j: Jurisdiction;
  let admin: TestUser;
  const open: TestCtx[] = [];

  beforeAll(async () => {
    const ctx = await createTestApp(); // the current (soon "old") keys
    open.push(ctx);
    j = await createJurisdiction(ctx.ds);
    citizen = await createUser(ctx, Role.CITIZEN, j);
    admin = await createUser(ctx, Role.SUB_ADMIN, j); // encrypted TOTP secret
  });

  afterAll(async () => {
    // Rotate back so later test files (same database, standard test keys) can read everything.
    const back = await withKeys({ PII_ENCRYPTION_KEY: oldEnc, PII_HASH_KEY: oldHash, PII_ENCRYPTION_KEY_PREVIOUS: b64(11), PII_HASH_KEY_PREVIOUS: b64(13) });
    open.push(back);
    const r = await rotatePiiKeys(back.ds, back.pii);
    for (const c of open) await c.app.close();
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    expect(r.unreadable).toEqual([]);
  });

  it('during, after and without the old keys: sign-in, MFA and decryption keep working; the job is resumable', async () => {
    // 1. New keys deployed, old ones kept as previous: old rows still found and readable.
    const during = await withKeys({ PII_ENCRYPTION_KEY: b64(11), PII_HASH_KEY: b64(13), PII_ENCRYPTION_KEY_PREVIOUS: oldEnc, PII_HASH_KEY_PREVIOUS: oldHash });
    open.push(during);
    let s = await login(during, citizen);
    expect((await during.http().get(api('/auth/me')).set(bearer(s.accessToken)).expect(200)).body.mobile).toBe(citizen.mobile);
    await login(during, admin); // TOTP secret decrypted with the previous key
    // Uniqueness still sees accounts indexed under the previous key (the unique index alone would not).
    await during.http().post(api('/auth/register')).send({
      homeWardId: j.wards[0].id, name: 'Asha Devi', mobile: citizen.mobile, email: `rot${Date.now()}@example.in`,
      password: PASSWORD, consentNoticeVersion: NOTICE_VERSION,
    }).expect(409);

    // 2. The job moves everything; a second run has nothing left to do.
    const first = await rotatePiiKeys(during.ds, during.pii, 50);
    expect(first.unreadable).toEqual([]);
    expect(first.updated).toBeGreaterThanOrEqual(2);
    expect(first.retry).toBe(0);
    const second = await rotatePiiKeys(during.ds, during.pii, 50);
    expect(second.updated).toBe(0);
    const [row] = await during.ds.query(`SELECT mobile_enc, mobile_hash FROM users WHERE id = $1`, [citizen.id]);
    expect(during.pii.isCurrent(row.mobile_enc)).toBe(true);
    expect(row.mobile_hash).toBe(during.pii.blindIndex(citizen.mobile));

    // 3. Old keys removed: nothing depended on them any more.
    const after = await withKeys({ PII_ENCRYPTION_KEY: b64(11), PII_HASH_KEY: b64(13) });
    open.push(after);
    s = await login(after, citizen);
    expect((await after.http().get(api('/auth/me')).set(bearer(s.accessToken)).expect(200)).body.mobile).toBe(citizen.mobile);
    await login(after, admin);
  });
});
