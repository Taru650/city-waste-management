export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  corsOrigins: string[];
  databaseUrl: string;
  jwtAccessSecret: string;
  jwtMfaSecret: string;
  piiEncryptionKey: Buffer;
  piiHashKey: Buffer;
  accessTokenTtlSeconds: number;
  refreshTtlDaysCitizen: number;
  refreshTtlDaysStaff: number;
  passwordResetUrl: string;
  rateLimitGlobalPerMin: number;
  rateLimitAuthPerMin: number;
  captchaSecret: string;
  captchaVerifyUrl: string;
  s3: {
    endpoint?: string;
    /** Host the apps use for pre-signed URLs when it differs from the internal endpoint. */
    publicEndpoint?: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
  };
  media: {
    maxCaptureAgeHours: number;
    maxGpsAccuracyM: number;
    videoMaxSeconds: number;
    /** x264 preset; 'slow' gives the best size/quality for production. */
    videoPreset: string;
  };
  clamav: { host?: string; port: number };
  redisUrl: string;
  /** api = HTTP only; worker = background jobs only; all = both (dev, tests, small pilots). */
  processRole: 'api' | 'worker' | 'all';
  mail: { transport: 'log' | 'smtp'; smtpUrl?: string; from: string };
  fcm: { serviceAccountJson?: string; apiBase: string };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}

function key32(env: NodeJS.ProcessEnv, name: string): Buffer {
  const buf = Buffer.from(required(env, name), 'base64');
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
  return buf;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return value;
}

/** Validates the environment once at boot; the app refuses to start on weak or missing secrets. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['env'];
  const config: AppConfig = {
    env: nodeEnv,
    port: Number(env.PORT ?? 3000),
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    databaseUrl: required(env, 'DATABASE_URL'),
    jwtAccessSecret: secret(env, 'JWT_ACCESS_SECRET'),
    jwtMfaSecret: secret(env, 'JWT_MFA_SECRET'),
    piiEncryptionKey: key32(env, 'PII_ENCRYPTION_KEY'),
    piiHashKey: key32(env, 'PII_HASH_KEY'),
    accessTokenTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTtlDaysCitizen: Number(env.REFRESH_TOKEN_TTL_DAYS_CITIZEN ?? 30),
    refreshTtlDaysStaff: Number(env.REFRESH_TOKEN_TTL_DAYS_STAFF ?? 7),
    passwordResetUrl: env.PASSWORD_RESET_URL ?? 'http://localhost:3001/reset-password',
    rateLimitGlobalPerMin: Number(env.RATE_LIMIT_GLOBAL_PER_MIN ?? 120),
    rateLimitAuthPerMin: Number(env.RATE_LIMIT_AUTH_PER_MIN ?? 10),
    captchaSecret: env.CAPTCHA_SECRET ?? '',
    captchaVerifyUrl: env.CAPTCHA_VERIFY_URL ?? 'https://hcaptcha.com/siteverify',
    s3: {
      endpoint: env.S3_ENDPOINT || undefined,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT || undefined,
      region: env.S3_REGION ?? 'ap-south-1',
      bucket: required(env, 'S3_BUCKET'),
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    },
    media: {
      maxCaptureAgeHours: Number(env.MEDIA_MAX_CAPTURE_AGE_HOURS ?? 24),
      maxGpsAccuracyM: Number(env.MEDIA_MAX_GPS_ACCURACY_M ?? 100),
      videoMaxSeconds: Number(env.VIDEO_MAX_SECONDS ?? 30),
      videoPreset: env.VIDEO_PRESET ?? 'slow',
    },
    clamav: { host: env.CLAMAV_HOST || undefined, port: Number(env.CLAMAV_PORT ?? 3310) },
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    processRole: (env.PROCESS_ROLE ?? 'all') as AppConfig['processRole'],
    mail: {
      transport: (env.MAIL_TRANSPORT ?? 'log') as 'log' | 'smtp',
      smtpUrl: env.SMTP_URL || undefined,
      from: env.MAIL_FROM ?? 'Swachh Seva <no-reply@example.gov.in>',
    },
    fcm: {
      // Firebase service-account JSON, base64 encoded. Without it pushes are recorded as SKIPPED.
      serviceAccountJson: env.FCM_SERVICE_ACCOUNT_B64 ? Buffer.from(env.FCM_SERVICE_ACCOUNT_B64, 'base64').toString('utf8') : undefined,
      apiBase: env.FCM_API_BASE ?? 'https://fcm.googleapis.com',
    },
  };
  if (!['api', 'worker', 'all'].includes(config.processRole)) throw new Error('PROCESS_ROLE must be api, worker or all');
  if (config.mail.transport === 'smtp' && !config.mail.smtpUrl) throw new Error('SMTP_URL is required when MAIL_TRANSPORT=smtp');
  if (config.jwtAccessSecret === config.jwtMfaSecret) {
    throw new Error('JWT_ACCESS_SECRET and JWT_MFA_SECRET must differ');
  }
  if (nodeEnv === 'production') {
    if (!config.captchaSecret) throw new Error('CAPTCHA_SECRET is required in production');
    if (config.corsOrigins.length === 0) throw new Error('CORS_ORIGINS is required in production');
    if (!config.clamav.host) throw new Error('CLAMAV_HOST is required in production (malware scanning of uploads)');
    if (config.mail.transport !== 'smtp') throw new Error('MAIL_TRANSPORT=smtp is required in production (password reset emails)');
    if (config.mail.smtpUrl && !/^smtps:\/\/|[?&]requireTLS=true/.test(config.mail.smtpUrl)) {
      throw new Error('SMTP_URL must use TLS in production (smtps:// or ?requireTLS=true)');
    }
  }
  return config;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
