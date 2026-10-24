// Shared configuration for the end-to-end environment (test-only secrets).
export const PORTS = { api: 3100, web: 3200, s3: 5055 };
export const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cwm_e2e_test';
export const S3 = { endpoint: `http://127.0.0.1:${PORTS.s3}`, bucket: 'cwm-media-e2e' };

export const apiEnv = {
  NODE_ENV: 'test',
  PORT: String(PORTS.api),
  DATABASE_URL: DB_URL,
  JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789-abcdefghijklmnop',
  JWT_MFA_SECRET: 'e2e-mfa-secret-0123456789-abcdefghijklmnopqrs',
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  PII_HASH_KEY: Buffer.alloc(32, 5).toString('base64'),
  CORS_ORIGINS: '',
  RATE_LIMIT_GLOBAL_PER_MIN: '100000',
  RATE_LIMIT_AUTH_PER_MIN: '100000',
  S3_ENDPOINT: S3.endpoint,
  S3_BUCKET: S3.bucket,
  S3_REGION: 'ap-south-1',
  S3_ACCESS_KEY_ID: 'test',
  S3_SECRET_ACCESS_KEY: 'test',
  S3_FORCE_PATH_STYLE: 'true',
  REDIS_URL: 'redis://127.0.0.1:6379/14',
  REDIS_PREFIX: 'cwm-e2e',
  PROCESS_ROLE: 'all',
  JOBS_SCHEDULES: 'off',
  MAIL_TRANSPORT: 'log',
  TRUST_PROXY_HOPS: '1',
};

export const webEnv = {
  API_URL: `http://127.0.0.1:${PORTS.api}/api/v1`,
  PORTAL_ORIGIN: `http://localhost:${PORTS.web}`,
  MEDIA_ORIGINS: S3.endpoint,
  // Local, so tests never depend on the internet; missing tiles are harmless.
  MAP_TILE_URL: `http://localhost:${PORTS.web}/tiles/{z}/{x}/{y}.png`,
  COOKIE_SECURE: 'true',
};

export const PASSWORD = 'Swachh#E2e2026';
