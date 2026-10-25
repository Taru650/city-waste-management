import { cookies } from 'next/headers';
import { backend } from './backend';
import { COOKIES } from './config';
import type { Me } from '../client/session';

/**
 * The signed-in user, loaded server-side for every portal page. null = the API does not accept the
 * session (sign in again); any other failure throws so the error page shows instead of the
 * sign-in page.
 */
export async function loadMe(): Promise<Me | null> {
  const token = (await cookies()).get(COOKIES.access)?.value;
  if (!token) return null;
  const res = await backend('/auth/me', { token });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Could not load the signed-in user (${res.status})`);
  return (await res.json()) as Me;
}
