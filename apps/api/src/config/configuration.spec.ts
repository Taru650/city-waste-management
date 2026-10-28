import { loadConfig } from './configuration';

const key = Buffer.alloc(32, 1).toString('base64');
const base = {
  DATABASE_URL: 'postgres://x',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_MFA_SECRET: 'b'.repeat(32),
  PII_ENCRYPTION_KEY: key,
  PII_HASH_KEY: Buffer.alloc(32, 2).toString('base64'),
  S3_BUCKET: 'media',
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
    [{ S3_BUCKET: '' }, /S3_BUCKET/],
    [{ PROCESS_ROLE: 'both' }, /PROCESS_ROLE/],
    [{ MAIL_TRANSPORT: 'smtp' }, /SMTP_URL/],
    [{ BREACHED_PASSWORD_CHECK: 'yes' }, /BREACHED_PASSWORD_CHECK must be on or off/],
    [{ PII_ENCRYPTION_KEY_PREVIOUS: key }, /PII_ENCRYPTION_KEY_PREVIOUS must differ/],
    [{ PII_HASH_KEY_PREVIOUS: Buffer.alloc(8).toString('base64') }, /PII_HASH_KEY_PREVIOUS must be 32 bytes/],
    [{ DB_STATEMENT_TIMEOUT_MS: '30s' }, /statementTimeoutMs must be a positive whole number/],
    [{ DB_POOL_MAX: '0' }, /poolMax must be a positive whole number/],
  ])('refuses to boot with %p', (override, msg) => {
    expect(() => loadConfig({ ...base, ...override })).toThrow(msg);
  });

  it('database limits: short statements for the API, longer for background jobs', () => {
    expect(loadConfig({ ...base, PROCESS_ROLE: 'api' }).db).toEqual({ poolMax: 20, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000, connectionTimeoutMs: 10_000 });
    expect(loadConfig({ ...base, PROCESS_ROLE: 'worker' }).db.statementTimeoutMs).toBe(300_000);
    expect(loadConfig({ ...base, DB_STATEMENT_TIMEOUT_MS: '45000' }).db.statementTimeoutMs).toBe(45_000);
  });

  it('previous PII keys are optional and only set during a rotation', () => {
    expect(loadConfig(base).piiEncryptionKeyPrevious).toBeNull();
    const c = loadConfig({ ...base, PII_ENCRYPTION_KEY_PREVIOUS: Buffer.alloc(32, 8).toString('base64'), PII_HASH_KEY_PREVIOUS: Buffer.alloc(32, 9).toString('base64') });
    expect(c.piiEncryptionKeyPrevious).toEqual(Buffer.alloc(32, 8));
    expect(c.piiHashKeyPrevious).toEqual(Buffer.alloc(32, 9));
  });

  it('requires CAPTCHA and CORS origins in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/CAPTCHA_SECRET/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', CAPTCHA_SECRET: 's' })).toThrow(/CORS_ORIGINS/);
    const prod = { ...base, NODE_ENV: 'production', CAPTCHA_SECRET: 's', CORS_ORIGINS: 'https://x' };
    expect(() => loadConfig(prod)).toThrow(/CLAMAV_HOST/);
    expect(() => loadConfig({ ...prod, CLAMAV_HOST: 'clamav' })).toThrow(/MAIL_TRANSPORT=smtp/);
    expect(() => loadConfig({ ...prod, CLAMAV_HOST: 'clamav', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://mail:25' })).toThrow(/TLS/);
    const smtp = { ...prod, CLAMAV_HOST: 'clamav', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtps://u:p@mail:465' };
    expect(() => loadConfig(smtp)).toThrow(/GRIEVANCE_OFFICER/);
    const officer = { ...smtp, GRIEVANCE_OFFICER_NAME: 'GO', GRIEVANCE_OFFICER_EMAIL: 'go@example.gov.in' };
    expect(() => loadConfig(officer)).toThrow(/BREACHED_PASSWORD_CHECK=on\|off is required/);
    const mailed = { ...officer, BREACHED_PASSWORD_CHECK: 'off' };
    expect(() => loadConfig(mailed)).toThrow(/PLAY_INTEGRITY_MODE=enforce/);
    const sa = Buffer.from('{"project_id":"p","client_email":"e","private_key":"k"}').toString('base64');
    const attested = { ...mailed, PLAY_INTEGRITY_MODE: 'enforce', PLAY_INTEGRITY_SERVICE_ACCOUNT_B64: sa };
    expect(() => loadConfig(attested)).toThrow(/PLAY_INTEGRITY_CERT_SHA256/);
    expect(() => loadConfig({ ...attested, PLAY_INTEGRITY_CERT_SHA256: 'abc' })).not.toThrow();
  });

  it('validates Play Integrity settings', () => {
    expect(() => loadConfig({ ...base, PLAY_INTEGRITY_MODE: 'strict' })).toThrow(/off, monitor or enforce/);
    expect(() => loadConfig({ ...base, PLAY_INTEGRITY_MODE: 'monitor' })).toThrow(/SERVICE_ACCOUNT/);
    expect(() => loadConfig({ ...base, PLAY_INTEGRITY_STAFF_LEVEL: 'MAX' })).toThrow(/BASIC, DEVICE or STRONG/);
    expect(loadConfig(base).playIntegrity).toEqual(expect.objectContaining({ mode: 'off', citizenLevel: 'BASIC', staffLevel: 'DEVICE' }));
  });
});
