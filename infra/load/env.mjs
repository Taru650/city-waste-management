// Load-test environment (test-only secrets). The API runs exactly as built, single process.
export const PORTS = { api: 3300, s3: 5057 };
export const DB_URL = process.env.LOAD_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cwm_load_test';
export const S3 = { endpoint: `http://127.0.0.1:${PORTS.s3}`, bucket: 'cwm-media-load' };
export const PASSWORD = 'Swachh#Load2026';
// Each simulated phone uses a fresh citizen every 9 complaints; an hour-long soak needs a big pool.
export const CITIZENS = Number(process.env.LOAD_CITIZENS ?? 10000);
// The API caps staff at 300 uploads/day (2 per task): an hour at 10× needs ~70 tasks per worker.
export const WORKERS = Number(process.env.LOAD_WORKERS ?? 40);
export const AREAS = 4;

export const apiEnv = {
  NODE_ENV: 'test',
  PORT: String(PORTS.api),
  DATABASE_URL: DB_URL,
  JWT_ACCESS_SECRET: 'load-access-secret-0123456789-abcdefghijklmnop',
  JWT_MFA_SECRET: 'load-mfa-secret-0123456789-abcdefghijklmnopqrs',
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  PII_HASH_KEY: Buffer.alloc(32, 13).toString('base64'),
  CORS_ORIGINS: '',
  // Every virtual user comes from 127.0.0.1: per-IP limits would only measure the limiter.
  RATE_LIMIT_GLOBAL_PER_MIN: '1000000',
  RATE_LIMIT_AUTH_PER_MIN: '1000000',
  S3_ENDPOINT: S3.endpoint,
  S3_BUCKET: S3.bucket,
  S3_REGION: 'ap-south-1',
  // Works for moto (any key) and MinIO (LOAD_S3=minio, stores to disk: moto keeps every object in
  // memory and died ~20 minutes into an hour-long soak).
  S3_ACCESS_KEY_ID: 'loadtestkey',
  S3_SECRET_ACCESS_KEY: 'loadtestsecret123',
  S3_FORCE_PATH_STYLE: 'true',
  REDIS_URL: 'redis://127.0.0.1:6379/13',
  REDIS_PREFIX: 'cwm-load',
  PROCESS_ROLE: 'all',
  JOBS_SCHEDULES: 'on',
  MAIL_TRANSPORT: 'log',
  VIDEO_PRESET: 'veryfast',
};
