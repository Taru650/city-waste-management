// Loaded before every e2e test file and by the global setup. Test-only secrets.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/cwm_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijklmnop';
process.env.JWT_MFA_SECRET = 'test-mfa-secret-0123456789-abcdefghijklmnopqrs';
process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PII_HASH_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.CORS_ORIGINS = 'https://portal.example.gov.in';
process.env.RATE_LIMIT_GLOBAL_PER_MIN = '100000';
process.env.RATE_LIMIT_AUTH_PER_MIN = '100000';
process.env.CAPTCHA_SECRET = '';
