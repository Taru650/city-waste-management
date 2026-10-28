import { redirect } from 'next/navigation';
import { currentUser } from '@/views/server/session';
import { safeNext } from '@/views/lib/safe-next';
import { Login } from '@/views/pages/Login';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = (await searchParams).next;
  // Already signed in (a valid session, checked against the database): nothing to do here.
  if (await currentUser()) redirect(safeNext(typeof next === 'string' ? next : null));
  return <Login />;
}
