import { redirect } from 'next/navigation';

/** The proxy already redirects "/"; this is the fallback if it is ever bypassed. */
export default function Home() {
  redirect('/dashboard');
}
