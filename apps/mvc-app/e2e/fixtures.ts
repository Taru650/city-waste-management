import { expect, Page } from '@playwright/test';
import mysql from 'mysql2/promise';
import { appEnv, PASSWORD } from './env.mjs';

/** The demo accounts from the seeders (README, "Demo logins"). */
export const USERS = {
  webAdmin: '9000000001',
  districtAdmin: '9000000002',
  subAdmin: '9000000003',
  supervisorNorth: '9000000004',
  supervisorSouth: '9000000005',
  worker1: '9000000006',
  worker2: '9000000007',
  subAdminParishad: '9000000008',
  districtAdmin2: '9000000009',
  citizen1: '9100000001',
} as const;
export type UserKey = keyof typeof USERS;

export async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const c = await mysql.createConnection({
    host: appEnv.DB_HOST, port: Number(appEnv.DB_PORT), user: appEnv.DB_USER, password: appEnv.DB_PASSWORD, database: appEnv.DB_NAME, dateStrings: true,
  });
  try {
    const [rows] = await c.query(query, params);
    return rows as T[];
  } finally {
    await c.end();
  }
}

/** Signs in through the real login page. */
export async function login(page: Page, key: UserKey, opts: { next?: string; expectPath?: RegExp; password?: string } = {}) {
  await page.goto(`/login${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ''}`);
  await page.getByLabel('Mobile number or email').fill(USERS[key]);
  await page.getByLabel('Password').fill(opts.password ?? PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(opts.expectPath ?? /\/dashboard/);
}

/** Signs out through the user menu and checks that the sign-out request really reached the server. */
export async function signOut(page: Page) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByTestId('user-menu').click();
  const loggedOut = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/logout') && r.request().method() === 'POST');
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  expect((await loggedOut).status()).toBe(204);
  await expect(page).toHaveURL(/\/login/);
}
