import { loadConfig } from './configuration';

const key = Buffer.alloc(32, 1).toString('base64');
const base = {
  DATABASE_URL: 'postgres://x',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_MFA_SECRET: 'b'.repeat(32),
  PII_ENCRYPTION_KEY: key,
  PII_HASH_KEY: Buffer.alloc(32, 2).toString('base64'),
};

describe('loadConfig', () => {
  it('loads a valid environment', () => {
    expect(loadConfig(base).databaseUrl).toBe('postgres://x');
  });

  it.each([
    [{ JWT_ACCESS_SECRET: 'short' }, /at least 32/],
    [{ JWT_MFA_SECRET: 'a'.repeat(32) }, /must differ/],
    [{ PII_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }, /32 bytes/],
    [{ DATABASE_URL: '' }, /DATABASE_URL/],
  ])('refuses to boot with %p', (override, msg) => {
    expect(() => loadConfig({ ...base, ...override })).toThrow(msg);
  });

  it('requires CAPTCHA and CORS origins in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/CAPTCHA_SECRET/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', CAPTCHA_SECRET: 's' })).toThrow(/CORS_ORIGINS/);
  });
});
