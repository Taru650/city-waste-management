import { serverConfig } from './config';

/**
 * Calls the NestJS API from the portal's server. The browser never talks to the API and
 * never sees an access or refresh token; it only holds httpOnly session cookies.
 */
export async function backend(
  path: string,
  init: { method?: string; body?: unknown; rawBody?: BodyInit; token?: string; headers?: Record<string, string>; forwardedFor?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', ...(init.headers ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.forwardedFor) headers['x-forwarded-for'] = init.forwardedFor;
  let body: BodyInit | undefined = init.rawBody;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  return fetch(`${serverConfig.apiUrl}${path}`, { method: init.method ?? 'GET', headers, body, cache: 'no-store', redirect: 'manual' });
}
