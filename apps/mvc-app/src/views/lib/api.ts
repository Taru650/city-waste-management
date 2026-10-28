'use client';

import useSWR, { SWRConfiguration } from 'swr';
import { hardNavigate } from '@/views/lib/navigate';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

const BASE = '/api/v1';
/** Cookie sessions need this header on every state-changing call (a cross-site form or image cannot send it). */
const CSRF = { 'x-cwm-csrf': '1' };

function errorMessage(body: unknown, fallback: string): string {
  const m = (body as { message?: unknown })?.message;
  if (Array.isArray(m)) return m.join('; ');
  return typeof m === 'string' ? m : fallback;
}

type Init = { method?: string; body?: unknown };

function send(path: string, init: Init): Promise<Response> {
  return fetch(path, {
    method: init.method ?? 'GET',
    headers: { ...CSRF, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
}

/** One browser-wide lock, so two tabs never spend the same single-use refresh token (that would end the session). */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (typeof navigator !== 'undefined' ? navigator.locks : undefined) as LockManager | undefined;
  return locks ? locks.request('cwm-session-renewal', fn) : fn();
}

let renewing: Promise<boolean> | null = null;

/**
 * Gets a fresh access cookie using the refresh cookie. Callers in this tab share one attempt; across tabs
 * the first one wins and the others find the cookie already working.
 */
export function renewSession(): Promise<boolean> {
  renewing ??= exclusive(async () => {
    const probe = await fetch(`${BASE}/auth/me`, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
    if (probe?.ok) return true;
    const res = await send(`${BASE}/auth/refresh`, { method: 'POST', body: {} }).catch(() => null);
    return !!res?.ok;
  }).finally(() => {
    renewing = null;
  });
  return renewing;
}

let ending = false;

/** The session is over (expired, signed out elsewhere, account disabled): clear the cookies and go to sign-in. */
export async function endSession(returnTo: string = window.location.pathname + window.location.search): Promise<void> {
  if (ending) return;
  ending = true;
  await send(`${BASE}/auth/logout`, { method: 'POST', body: {} }).catch(() => undefined);
  hardNavigate(`/login?next=${encodeURIComponent(returnTo)}`);
}

/** Browser to API call: same origin, cookie session, one silent renewal on 401, JSON in and out. */
export async function call<T = unknown>(path: string, init: Init = {}): Promise<T> {
  let res = await send(path, init);
  // The auth endpoints answer 401 for wrong credentials; that is not an expired session.
  if (res.status === 401 && !path.startsWith(`${BASE}/auth/`)) {
    if (await renewSession()) res = await send(path, init);
    if (res.status === 401) {
      void endSession();
      throw new ApiError(401, 'Session expired');
    }
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) throw new ApiError(res.status, errorMessage(body, `Request failed (${res.status})`), body);
  return body as T;
}

export const api = <T = unknown>(path: string, init?: Init) => call<T>(`${BASE}${path}`, init);

/** Build a query string, dropping empty values. */
export function qs(params: Record<string, unknown>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
}

export function useApi<T>(path: string | null, config?: SWRConfiguration<T>) {
  return useSWR<T>(path, (p: string) => api<T>(p), { revalidateOnFocus: false, ...config });
}
