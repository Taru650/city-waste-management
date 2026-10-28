import { z, ZodError, type ZodType } from 'zod';
import { getConfig } from '@/config/env';
import { HttpError, forbidden, isDbUnavailable, unauthorized, unavailable } from '@/lib/errors';
import type { Role } from '@/lib/enums';
import { authenticate, type AuthUser } from './auth';
import { clientInfo, csrfOk, type ClientInfo } from './http';
import { rateLimit } from './rateLimit';

/** What a handler can return besides plain data: a status, extra headers, cookies to set. */
export class ApiResult {
  constructor(
    public readonly body: unknown,
    public readonly init: { status?: number; headers?: Record<string, string>; cookies?: string[] } = {},
  ) {}
}

export interface Ctx<B, Q, P> {
  req: Request;
  /** null only on public routes. */
  user: AuthUser;
  body: B;
  query: Q;
  params: P;
  client: ClientInfo;
}

export interface RouteOptions<B extends ZodType | undefined, Q extends ZodType | undefined> {
  /** No sign-in needed (registration, login, dropdowns). */
  public?: boolean;
  /** Roles allowed; omit for any signed-in user. */
  roles?: Role[];
  body?: B;
  query?: Q;
  /** Strict per-IP limit for credential endpoints (login, register, password reset). */
  throttle?: 'auth';
  /** Let a user who must still change a temporary password call this (change-password, me, logout). */
  allowPendingPasswordChange?: boolean;
  /** Let a citizen who has not accepted the current privacy notice call this (consent, account, logout). */
  allowWithoutConsent?: boolean;
  /** The handler reads the request body itself (file uploads). */
  rawBody?: boolean;
  maxBodyBytes?: number;
}

type Infer<T extends ZodType | undefined> = T extends ZodType ? z.infer<T> : undefined;
type RouteContext = { params: Promise<Record<string, string>> };
type Handler<B, Q, P> = (ctx: Ctx<B, Q, P>) => Promise<unknown> | unknown;

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-site',
};

const bodyShape = (status: number, message: string | string[], extra: Record<string, unknown> = {}) => ({ statusCode: status, message, ...extra });

export function json(body: unknown, init: { status?: number; headers?: Record<string, string>; cookies?: string[] } = {}): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...(init.headers ?? {}) });
  for (const c of init.cookies ?? []) headers.append('Set-Cookie', c);
  const status = init.status ?? 200;
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function errorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    const messages = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    return json(bodyShape(400, messages, { error: 'Bad Request' }), { status: 400 });
  }
  if (err instanceof HttpError) {
    const headers: Record<string, string> = {};
    const retry = (err as { retryAfter?: number }).retryAfter;
    if (retry) headers['Retry-After'] = String(retry);
    return json(bodyShape(err.status, err.message, { ...(err.code ? { code: err.code } : {}), ...(err.extra ?? {}) }), { status: err.status, headers });
  }
  if (isDbUnavailable(err)) {
    console.error('[api] database unavailable:', (err as Error).message);
    const e = unavailable();
    return json(bodyShape(e.status, e.message), { status: e.status });
  }
  console.error('[api] unhandled error:', err);
  return json(bodyShape(500, 'Internal server error'), { status: 500 });
}

/** Text of the request body with a size cap; rejects NUL bytes (they break some databases and filters). */
async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > maxBytes) throw new HttpError(413, 'Payload too large');
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, 'Payload too large');
  if (text === '') return undefined;
  if (text.includes('\u0000') || /\\u0000/i.test(text)) throw new HttpError(400, 'Malformed request');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Malformed JSON');
  }
}

/**
 * Wraps a controller function into a Next.js route handler and applies, in this order: rate limits,
 * sign-in, role check, forced password change, consent gate, CSRF check (cookie sessions only),
 * body/query validation, then your code. Anything thrown becomes a clean JSON error.
 */
export function route<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P = Record<string, string>>(
  opts: RouteOptions<B, Q>,
  handler: Handler<Infer<B>, Infer<Q>, P>,
) {
  return async (req: Request, context?: RouteContext): Promise<Response> => {
    try {
      const cfg = getConfig();
      const client = clientInfo(req);
      const url = new URL(req.url);
      if (url.pathname.includes('\u0000') || url.search.includes('%00')) throw new HttpError(400, 'Malformed request');

      const ipKey = client.ip ?? 'direct';
      rateLimit(`g:${ipKey}`, cfg.rateLimit.globalPerMin);
      if (opts.throttle === 'auth') rateLimit(`a:${ipKey}:${url.pathname}`, cfg.rateLimit.authPerMin);

      let user: AuthUser | null = null;
      if (!opts.public) {
        user = await authenticate(req);
        if (!user) throw unauthorized();
        if (opts.roles && !opts.roles.includes(user.role)) throw forbidden();
        if (user.mustChangePassword && !opts.allowPendingPasswordChange) throw forbidden('Password change required');
        if (user.consentRequired && !opts.allowWithoutConsent) {
          throw forbidden('Please read and accept the current privacy notice', 'CONSENT_REQUIRED');
        }
        if (user.via === 'cookie' && !csrfOk(req)) throw forbidden();
      } else if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.get('cookie') && !csrfOk(req)) {
        // Public write endpoints also refuse cross-site browser requests (login CSRF, forced registrations).
        throw forbidden();
      }

      let body: unknown;
      if (opts.body) {
        const ct = req.headers.get('content-type') ?? '';
        if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
        body = opts.body.parse((await readJson(req, opts.maxBodyBytes ?? 1_000_000)) ?? {});
      } else if (!opts.rawBody && !['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(req.method)) {
        // Endpoints without a body ignore anything sent, but it must still be well formed and small.
        await readJson(req, opts.maxBodyBytes ?? 1_000_000);
      }
      const query = opts.query ? opts.query.parse(Object.fromEntries(url.searchParams)) : undefined;
      const params = (context?.params ? await context.params : {}) as P;

      const result = await handler({ req, user: user as AuthUser, body: body as Infer<B>, query: query as Infer<Q>, params, client });
      if (result instanceof Response) return result;
      if (result instanceof ApiResult) return json(result.body, result.init);
      return json(result === undefined ? { status: 'OK' } : result);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Maps a numeric path parameter check: a valid UUID or a 404 (never a database error). */
export function uuidParam(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(404, 'Not found');
  return value;
}
