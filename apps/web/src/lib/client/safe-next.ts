/** Post-login redirect target: only same-site relative paths, never another origin (open redirect). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/dashboard';
  try {
    // Resolve against a dummy origin; anything that escapes it is rejected.
    const u = new URL(next, 'http://portal.invalid');
    return u.origin === 'http://portal.invalid' ? `${u.pathname}${u.search}${u.hash}` : '/dashboard';
  } catch {
    return '/dashboard';
  }
}
