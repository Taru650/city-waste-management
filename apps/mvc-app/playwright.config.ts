import { defineConfig, devices } from '@playwright/test';
import { appEnv, PORT } from './e2e/env.mjs';

/**
 * Real browser, real production build, real MySQL (a throwaway demo database).
 * Build first:  npm run build      Run:  npm run test:e2e
 * If the browser download is blocked, point PW_CHROMIUM at an installed Chrome/Chromium executable.
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
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: `node e2e/prepare.mjs && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    env: { ...process.env, ...appEnv } as Record<string, string>,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
