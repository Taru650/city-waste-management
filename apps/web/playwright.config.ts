import { defineConfig, devices } from '@playwright/test';
import { apiEnv, PORTS, webEnv } from './e2e/env.mjs';

/**
 * Real browser, real portal (production build), real API, real PostgreSQL/PostGIS, Redis and
 * S3 (moto). The API's start command first prepares and seeds a fresh e2e database.
 * Build both apps first: `npm --prefix ../api run build && npm run build`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORTS.web}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node e2e/prepare.mjs && node ../api/dist/main.js',
      url: `http://127.0.0.1:${PORTS.api}/api/v1/health/ready`,
      env: { ...process.env, ...apiEnv } as Record<string, string>,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
    },
    {
      command: `npx next start -p ${PORTS.web}`,
      url: `http://localhost:${PORTS.web}/login`,
      env: { ...process.env, ...webEnv, NODE_ENV: 'production' } as Record<string, string>,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
