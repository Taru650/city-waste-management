import { cookies } from 'next/headers';
import { AuthService } from '@/services/AuthService';
import { authenticate } from '@/middleware/auth';
import { COOKIES } from '@/middleware/http';

/** The signed-in user as the website's pages need them (the same data as GET /api/v1/auth/me). */
export interface PortalUser {
  id: string;
  role: 'WEB_ADMIN' | 'DISTRICT_ADMIN' | 'SUB_ADMIN' | 'SUPERVISOR' | 'WORKER' | 'CITIZEN';
  name: string;
  mobile: string;
  email: string | null;
  districtId: string | null;
  ulbId: string | null;
  mustChangePassword: boolean;
  preferredLanguage: 'hi' | 'en';
}

/**
 * Who is signed in, for server-rendered pages. Runs the same token check as every API call (signature,
 * expiry, account status, password version, live session) without an HTTP round trip.
 * null = no valid session; the page decides where to send the visitor.
 */
export async function currentUser(): Promise<PortalUser | null> {
  const token = (await cookies()).get(COOKIES.access)?.value;
  if (!token) return null;
  const user = await authenticate(new Request('http://session.invalid/', { headers: { cookie: `${COOKIES.access}=${encodeURIComponent(token)}` } }));
  if (!user) return null;
  const me = await AuthService.me(user.id);
  return {
    id: me.id, role: me.role, name: me.name, mobile: me.mobile ?? '', email: me.email ?? null,
    districtId: me.districtId ?? null, ulbId: me.ulbId ?? null,
    mustChangePassword: me.mustChangePassword, preferredLanguage: me.preferredLanguage,
  };
}
