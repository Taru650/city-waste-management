/**
 * Which API paths the browser may reach through /bff/api. Token-issuing endpoints are served
 * by /bff/auth/* (tokens go into httpOnly cookies, never to JS) and media capture and Play Integrity attestation are mobile-only.
 *
 * The API (Express) matches routes case-insensitively and ignores trailing/duplicate slashes,
 * so the path is normalised the same way before matching; otherwise "AUTH/login" or
 * "auth/login/" would slip past the blocklist and reach the token endpoint.
 */
const BLOCKED = [
  /^auth\/(login|refresh|logout|register|change-password|reset-password|forgot-password)$/,
  /^auth\/mfa\/(enroll|activate|verify|recover)$/,
  /^media(\/|$)/,
  /^devices(\/|$)/,
  /^attestation(\/|$)/,
];

export function normalisePath(segments: string[]): string {
  return segments
    .map((s) => decodeURIComponent(s))
    .flatMap((s) => s.split('/'))
    .filter((s) => s !== '' && s !== '.')
    .join('/');
}

export function isBlocked(segments: string[]): boolean {
  const path = normalisePath(segments).toLowerCase();
  if (path.split('/').includes('..')) return true;
  return BLOCKED.some((re) => re.test(path));
}
