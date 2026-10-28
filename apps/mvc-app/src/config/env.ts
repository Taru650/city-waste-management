import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Every setting the app reads, validated once. A missing or malformed value stops the app at
 * start-up with a message saying which variable to fix (instead of failing later, mid-request).
 */
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max).default(def);
const base64Key = (name: string) =>
  z
    .string()
    .min(1, `${name} is empty. Run: npm run gen:secrets`)
    .refine((v) => Buffer.from(v, 'base64').length === 32, `${name} must be 32 random bytes, base64 encoded. Run: npm run gen:secrets`)
    .transform((v) => Buffer.from(v, 'base64'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: int(3306, 1, 65535),
  DB_NAME: z.string().min(1).default('cwm_mvc'),
  DB_TEST_NAME: z.string().min(1).default('cwm_mvc_test'),
  DB_USER: z.string().min(1).default('cwm'),
  DB_PASSWORD: z.string().default(''),
  DB_POOL_MAX: int(10, 1, 200),
  DB_CONNECT_TIMEOUT_MS: int(10_000, 100),
  DB_QUERY_TIMEOUT_MS: int(30_000, 100),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters. Run: npm run gen:secrets'),
  PII_ENCRYPTION_KEY: base64Key('PII_ENCRYPTION_KEY'),
  PII_HASH_KEY: base64Key('PII_HASH_KEY'),

  ACCESS_TOKEN_TTL_SECONDS: int(900, 60, 3600),
  REFRESH_TTL_DAYS_STAFF: int(7, 1, 90),
  REFRESH_TTL_DAYS_CITIZEN: int(30, 1, 180),

  COOKIE_SECURE: bool.optional(),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY_HOPS: int(0, 0, 10),
  RATE_LIMIT_GLOBAL_PER_MIN: int(240, 1),
  RATE_LIMIT_AUTH_PER_MIN: int(10, 1),

  STORAGE_DIR: z.string().min(1).default('./storage'),
  MEDIA_MAX_CAPTURE_AGE_HOURS: int(24, 1),
  MEDIA_MAX_GPS_ACCURACY_M: int(100, 1),
  VIDEO_MAX_SECONDS: int(30, 1),
  /** Optional: full path to ffmpeg/ffprobe. Without them videos are stored as uploaded (no re-encode, no thumbnail). */
  FFMPEG_PATH: z.string().default(''),
  FFPROBE_PATH: z.string().default(''),
  /** Optional ClamAV daemon. Without it uploads are checked for the EICAR test signature only. */
  CLAMAV_HOST: z.string().default(''),
  CLAMAV_PORT: int(3310, 1, 65535),

  /** Optional push notifications: the Firebase service-account JSON (one line). Empty = in-app notifications only. */
  FCM_SERVICE_ACCOUNT_JSON: z.string().default(''),
  FCM_API_BASE: z.string().url().default('https://fcm.googleapis.com'),

  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('Swachh Seva <no-reply@example.gov.in>'),

  /** Shown in the privacy notice (DPDP Act). Required in production. */
  GRIEVANCE_OFFICER_NAME: z.string().default(''),
  GRIEVANCE_OFFICER_EMAIL: z.string().default(''),
  GRIEVANCE_OFFICER_PHONE: z.string().default(''),

  DEMO_CENTER_LAT: z.coerce.number().min(-90).max(90).default(21.2514),
  DEMO_CENTER_LNG: z.coerce.number().min(-180).max(180).default(81.6296),
});

export type AppConfig = ReturnType<typeof build>;

function build(env: NodeJS.ProcessEnv) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`Configuration problem in your .env file:\n${lines.join('\n')}\n\nSee README.md, "Environment variables".`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const cookieSecure = e.COOKIE_SECURE ?? production;
  if (production && !cookieSecure) throw new Error('COOKIE_SECURE must be true in production (browsers only keep secure cookies over HTTPS).');
  if (production && e.TRUST_PROXY_HOPS < 1) {
    throw new Error('TRUST_PROXY_HOPS must be at least 1 in production: run the app behind an HTTPS reverse proxy and set the number of proxies (otherwise client IPs cannot be trusted).');
  }
  if (production && (!e.GRIEVANCE_OFFICER_NAME || !e.GRIEVANCE_OFFICER_EMAIL)) {
    throw new Error('GRIEVANCE_OFFICER_NAME and GRIEVANCE_OFFICER_EMAIL are required in production (they are printed in the DPDP privacy notice).');
  }
  if (production && e.MAIL_TRANSPORT === 'smtp' && !e.SMTP_URL) throw new Error('SMTP_URL is required when MAIL_TRANSPORT=smtp.');
  return {
    env: e.NODE_ENV,
    production,
    appUrl: e.APP_URL.replace(/\/$/, ''),
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      name: e.NODE_ENV === 'test' ? e.DB_TEST_NAME : e.DB_NAME,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      poolMax: e.DB_POOL_MAX,
      connectTimeoutMs: e.DB_CONNECT_TIMEOUT_MS,
      queryTimeoutMs: e.DB_QUERY_TIMEOUT_MS,
    },
    jwtAccessSecret: new TextEncoder().encode(e.JWT_ACCESS_SECRET),
    piiEncryptionKey: e.PII_ENCRYPTION_KEY,
    piiHashKey: e.PII_HASH_KEY,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDaysStaff: e.REFRESH_TTL_DAYS_STAFF,
    refreshTtlDaysCitizen: e.REFRESH_TTL_DAYS_CITIZEN,
    cookieSecure,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    trustProxyHops: e.TRUST_PROXY_HOPS,
    rateLimit: { globalPerMin: e.RATE_LIMIT_GLOBAL_PER_MIN, authPerMin: e.RATE_LIMIT_AUTH_PER_MIN },
    storageDir: e.STORAGE_DIR,
    media: {
      maxCaptureAgeHours: e.MEDIA_MAX_CAPTURE_AGE_HOURS,
      maxGpsAccuracyM: e.MEDIA_MAX_GPS_ACCURACY_M,
      videoMaxSeconds: e.VIDEO_MAX_SECONDS,
      ffmpegPath: e.FFMPEG_PATH || 'ffmpeg',
      ffprobePath: e.FFPROBE_PATH || 'ffprobe',
    },
    clamav: { host: e.CLAMAV_HOST, port: e.CLAMAV_PORT },
    fcm: { serviceAccountJson: e.FCM_SERVICE_ACCOUNT_JSON, apiBase: e.FCM_API_BASE.replace(/\/$/, '') },
    grievanceOfficer: { name: e.GRIEVANCE_OFFICER_NAME, email: e.GRIEVANCE_OFFICER_EMAIL, phone: e.GRIEVANCE_OFFICER_PHONE },
    mail: { transport: e.MAIL_TRANSPORT, smtpUrl: e.SMTP_URL, from: e.MAIL_FROM },
    passwordResetUrl: `${e.APP_URL.replace(/\/$/, '')}/reset-password`,
    demoCenter: { lat: e.DEMO_CENTER_LAT, lng: e.DEMO_CENTER_LNG },
  };
}

let cached: AppConfig | undefined;
let dotenvLoaded = false;

/** The validated configuration (read once, then cached). */
export function getConfig(): AppConfig {
  if (!cached) {
    if (!dotenvLoaded) {
      loadDotenv({ quiet: true }); // does not override variables that are already set
      dotenvLoaded = true;
    }
    cached = build(process.env);
  }
  return cached;
}

/** For tests: read the environment again after changing it. */
export function resetConfigForTests() {
  cached = undefined;
}

export { build as buildConfig };
