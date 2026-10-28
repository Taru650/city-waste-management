// Shared settings for the browser tests. Test-only secrets; the database is a throwaway demo copy.
import { config } from 'dotenv';

config({ quiet: true }); // take the MySQL login from .env
export const PORT = 3100;
export const DB_NAME = 'cwm_mvc_e2e';
export const PASSWORD = 'Demo@12345';

const db = {
  DB_HOST: process.env.DB_HOST ?? '127.0.0.1',
  DB_PORT: process.env.DB_PORT ?? '3306',
  DB_USER: process.env.DB_USER ?? 'cwm',
  DB_PASSWORD: process.env.DB_PASSWORD ?? '',
  DB_NAME,
  STORAGE_DIR: './storage-e2e',
};

/** The production build, run the way a real deployment is configured (secure cookies, one proxy hop). */
export const appEnv = {
  ...db,
  NODE_ENV: 'production',
  APP_URL: `http://localhost:${PORT}`,
  JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  PII_HASH_KEY: Buffer.alloc(32, 5).toString('base64'),
  COOKIE_SECURE: 'true',
  TRUST_PROXY_HOPS: '1',
  RATE_LIMIT_GLOBAL_PER_MIN: '100000',
  RATE_LIMIT_AUTH_PER_MIN: '100000',
  MAIL_TRANSPORT: 'log',
  GRIEVANCE_OFFICER_NAME: 'Demo Grievance Officer',
  GRIEVANCE_OFFICER_EMAIL: 'grievance@example.gov.in',
  // Local, so the tests never depend on the internet; missing tiles are harmless.
  MAP_TILE_URL: `http://localhost:${PORT}/tiles/{z}/{x}/{y}.png`,
  CORS_ORIGINS: 'https://partner.example',
};

/** Same database, but allowed to rebuild it (the reset command refuses to run in production mode). */
export const prepareEnv = { ...appEnv, NODE_ENV: 'development' };
