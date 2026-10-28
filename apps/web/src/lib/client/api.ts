'use client';

import useSWR, { SWRConfiguration } from 'swr';
import { hardNavigate } from '@/lib/client/navigate';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

function errorMessage(body: unknown, fallback: string): string {
  const m = (body as { message?: unknown })?.message;
  if (Array.isArray(m)) return m.join('; ');
  return typeof m === 'string' ? m : fallback;
}

/** All browser → server calls go through the same-origin BFF with the CSRF header. */
export async function call<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { 'x-cwm-csrf': '1', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 401 && path.startsWith('/bff/api/')) {
    hardNavigate(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new ApiError(401, 'Session expired');
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, errorMessage(body, `Request failed (${res.status})`), body);
  return body as T;
}

export const api = <T = unknown>(path: string, init?: { method?: string; body?: unknown }) => call<T>(`/bff/api${path}`, init);

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
