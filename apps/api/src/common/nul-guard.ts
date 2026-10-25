/**
 * PostgreSQL text cannot hold NUL (U+0000); such values reached the database and came back as 500s
 * (found by the authenticated ZAP scan). No legitimate client sends them, so refuse the whole
 * request up front, for every endpoint, before validation or SQL.
 */
export function containsNul(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v.includes('\u0000');
  if (depth > 20 || v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => containsNul(x, depth + 1));
  return Object.entries(v as Record<string, unknown>).some(([k, x]) => k.includes('\u0000') || containsNul(x, depth + 1));
}

type Req = { url: string; query?: unknown; body?: unknown };
type Res = { status(code: number): { json(body: unknown): void } };

export function nulGuard(req: Req, res: Res, next: () => void) {
  let url = req.url;
  try {
    url = decodeURIComponent(req.url);
  } catch {
    // malformed escapes are rejected later by the router/validation
  }
  if (url.includes('\u0000') || containsNul(req.query) || containsNul(req.body)) {
    return res.status(400).json({ statusCode: 400, error: 'Bad Request', message: 'Invalid characters in request' });
  }
  next();
}
