import { cookies } from 'next/headers';
import { backend } from './backend';
import { COOKIES } from './config';
import type { Me } from '../client/session';

/** The signed-in user, loaded server-side for every portal page (null = not signed in). */
export async function loadMe(): Promise<Me | null> {
  const token = (await cookies()).get(COOKIES.access)?.value;
  if (!token) return null;
  const res = await backend('/auth/me', { token });
  if (!res.ok) return null;
  return (await res.json()) as Me;
}
