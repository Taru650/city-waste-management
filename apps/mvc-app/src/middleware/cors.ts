/**
 * Browser access from other websites (CORS_ORIGINS). Only listed origins get any CORS headers, and
 * credentials are never allowed: a page on another site can call the API with a bearer token it holds,
 * but it can never ride on a visitor's cookies. Mobile apps are not browsers and need none of this.
 */
export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> | null {
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
    'Access-Control-Expose-Headers': 'Retry-After, Content-Disposition',
    'Access-Control-Max-Age': '600',
  };
}
