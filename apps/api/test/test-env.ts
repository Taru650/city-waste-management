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
process.env.S3_ENDPOINT ??= 'http://127.0.0.1:5055';
process.env.S3_BUCKET = 'cwm-media-test';
process.env.S3_REGION = 'ap-south-1';
process.env.S3_ACCESS_KEY_ID = 'test';
process.env.S3_SECRET_ACCESS_KEY = 'test';
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.VIDEO_PRESET = 'ultrafast';
delete process.env.CLAMAV_HOST;
// Redis DB 15 is reserved for tests and flushed by the global setup.
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379/15';
process.env.REDIS_PREFIX = 'cwm-test';
process.env.PROCESS_ROLE = 'all';
// Tests trigger sweeps explicitly; timers would make assertions racy.
process.env.JOBS_SCHEDULES = 'off';
process.env.MAIL_TRANSPORT = 'log';
delete process.env.FCM_SERVICE_ACCOUNT_B64;
