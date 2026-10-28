import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { MobileOnly } from '@/components/MobileOnly';
import { loadMe } from '@/lib/server/me';

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const me = await loadMe();
  const path = (await headers()).get('x-pathname') ?? '/dashboard';
  // The browser holds a token the API rejects; only a route handler can fix its cookies.
  if (!me) redirect(`/bff/auth/session-ended?next=${encodeURIComponent(path)}`);
  // Field workers and citizens use the mobile apps; the portal is for administrators and supervisors.
  if (me.role === 'WORKER' || me.role === 'CITIZEN') return <MobileOnly role={me.role} />;
  if (me.mustChangePassword && path !== '/account') redirect('/account?mustChange=1');
  return <AppShell me={me}>{children}</AppShell>;
}
