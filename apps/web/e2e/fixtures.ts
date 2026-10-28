import { expect, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import pg from 'pg';
import { DB_URL } from './env.mjs';

export interface SeedUser { id: string; role: string; mobile: string; email: string; password: string; mfaSecret: string | null }
export interface Seed {
  users: Record<string, SeedUser>;
  complaints: Record<string, { id: string; no: string }>;
  ulbs: { A: string; B: string };
  wards: Record<string, string>;
  areaId: string;
  districtId: string;
}

let cached: Seed | undefined;
export function seed(): Seed {
  cached ??= JSON.parse(readFileSync(join(__dirname, '.auth/fixtures.json'), 'utf8'));
  return cached!;
}

export async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return (await c.query(query, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Signs in through the real login page, including the TOTP step for administrators. */
export async function login(page: Page, key: string, opts: { next?: string; expectPath?: RegExp } = {}) {
  const u = seed().users[key];
  // A TOTP code is accepted once per 30 s window; tests sign the same admin in repeatedly.
  if (u.mfaSecret) await sql(`UPDATE users SET mfa_last_step = NULL WHERE id = $1`, [u.id]);
  await page.goto(`/login${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ''}`);
  await page.getByLabel('Mobile number or email').fill(u.mobile);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (u.mfaSecret) {
    await page.getByLabel('Authenticator code').fill(authenticator.generate(u.mfaSecret));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page).toHaveURL(opts.expectPath ?? /\/dashboard/);
}

/** Signs out through the user menu and checks the sign-out request really went to the server. */
export async function signOut(page: Page) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByTestId('user-menu').click();
  const loggedOut = page.waitForResponse((r) => r.url().endsWith('/bff/auth/logout') && r.request().method() === 'POST');
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  expect((await loggedOut).status()).toBe(200);
  await expect(page).toHaveURL(/\/login/);
}
