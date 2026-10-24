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
  };
  if (config.jwtAccessSecret === config.jwtMfaSecret) {
    throw new Error('JWT_ACCESS_SECRET and JWT_MFA_SECRET must differ');
  }
  if (nodeEnv === 'production') {
    if (!config.captchaSecret) throw new Error('CAPTCHA_SECRET is required in production');
    if (config.corsOrigins.length === 0) throw new Error('CORS_ORIGINS is required in production');
  }
  return config;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
