import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

/**
 * Last line of defence: unknown errors (DB, driver, bugs) are logged server-side and
 * returned as a bare 500 so stack traces, SQL and constraint names never reach clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Unhandled');
  /** Outages and limits are expected operating conditions, logged apart from bugs. */
  private readonly deps = new Logger('Dependencies');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (exception instanceof ThrottlerException) {
      return res.status(HttpStatus.TOO_MANY_REQUESTS).json({ statusCode: 429, message: 'Too many requests' });
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      // Clients read `message`; `new HttpException('text', status)` would otherwise send a bare string.
      return res.status(exception.getStatus()).json(typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body);
    }
    const err = exception as { type?: string; status?: number; code?: string; message?: string };
    // Database limits (data-source.ts) and outages: the client gets a clear, retryable answer, the log the details.
    if (err?.code === '57014' || err?.code === '25P03' || /timeout exceeded when trying to connect/.test(err?.message ?? '')) {
      this.deps.warn(`Database limit hit: ${err.code ?? ''} ${err.message ?? ''}`.trim());
      return res.status(503).json({ statusCode: 503, message: 'The server is busy or the request took too long. Please try again, or narrow the filters.' });
    }
    if (isConnectionFailure(err)) {
      this.deps.error(`Dependency unavailable: ${err.code ?? ''} ${err.message ?? ''}`.trim());
      return res.status(503).json({ statusCode: 503, message: 'The service is temporarily unavailable. Please try again shortly.' });
    }
    // body-parser errors (payload too large, malformed JSON) carry their own status.
    if (err?.type === 'entity.too.large') return res.status(413).json({ statusCode: 413, message: 'Payload too large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ statusCode: 400, message: 'Malformed JSON' });

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}

const NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/** Database (or other backing service) unreachable, restarting or cut off: retryable, not a bug. */
function isConnectionFailure(err: { code?: string; message?: string } | undefined): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  return NETWORK_ERRORS.has(code) || code.startsWith('08') || ['57P01', '57P02', '57P03'].includes(code)
    || /^Connection terminated/.test(err.message ?? '');
}
