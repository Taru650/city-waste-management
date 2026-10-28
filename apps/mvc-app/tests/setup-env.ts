/** Runs inside every test worker, before the app code: fixed secrets and generous limits, so tests never depend on a developer's .env. */
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PII_HASH_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_PROXY_HOPS = '0';
process.env.RATE_LIMIT_GLOBAL_PER_MIN = '100000';
process.env.RATE_LIMIT_AUTH_PER_MIN = '100000';
process.env.MAIL_TRANSPORT = 'log';
process.env.APP_URL = 'http://localhost:3000';
process.env.STORAGE_DIR = './storage-test';
