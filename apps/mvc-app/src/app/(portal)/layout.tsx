import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShell } from '@/views/components/AppShell';
import { MobileOnly } from '@/views/components/MobileOnly';
import { currentUser } from '@/views/server/session';

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const me = await currentUser();
  const path = (await headers()).get('x-pathname') ?? '/dashboard';
  // Cookie missing, expired or rejected: /session tries one renewal, otherwise ends the session cleanly.
  if (!me) redirect(`/session?next=${encodeURIComponent(path)}`);
  // Field workers and citizens use the mobile apps; the website is for administrators and supervisors.
  if (me.role === 'WORKER' || me.role === 'CITIZEN') return <MobileOnly role={me.role} />;
  if (me.mustChangePassword && path !== '/account') redirect('/account?mustChange=1');
  return <AppShell me={me}>{children}</AppShell>;
}
