/** Errors the API answers with a specific status. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    /** Extra fields for the JSON error body (for example mediaStatus). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = 'Unauthorized') => new HttpError(401, m);
export const forbidden = (m = 'Forbidden', code?: string) => new HttpError(403, m, code);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);
export const tooMany = (m = 'Too many requests') => new HttpError(429, m);
export const unavailable = (m = 'The service is temporarily unavailable. Please try again shortly.') => new HttpError(503, m);

const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'PROTOCOL_CONNECTION_LOST']);
// 1205 lock wait timeout, 1213 deadlock, 3024 query execution time exceeded, 1040 too many connections
const DB_BUSY = new Set(['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK', 'ER_QUERY_TIMEOUT', 'ER_CON_COUNT_ERROR']);

/** The database is unreachable, restarting, or too slow: retryable, not a bug. */
export function isDbUnavailable(err: unknown): boolean {
  const e = err as { code?: string; name?: string; message?: string } | undefined;
  if (!e) return false;
  return (
    NETWORK.has(e.code ?? '') ||
    DB_BUSY.has(e.code ?? '') ||
    e.name === 'KnexTimeoutError' ||
    /Knex: Timeout acquiring a connection|Connection lost|Pool is closed/i.test(e.message ?? '')
  );
}

export function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: string })?.code === 'ER_DUP_ENTRY';
}

/** MySQL rejected a geometry (invalid GeoJSON, bad ring, or an operation it cannot compute robustly). */
export function isGeometryError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  return /GIS|GEOJSON|GEOMETRY|SRS|ST_/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
}
