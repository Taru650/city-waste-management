import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

/**
 * Last line of defence: unknown errors (DB, driver, bugs) are logged server-side and
 * returned as a bare 500 so stack traces, SQL and constraint names never reach clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Unhandled');

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
    const err = exception as { type?: string; status?: number };
    // body-parser errors (payload too large, malformed JSON) carry their own status.
    if (err?.type === 'entity.too.large') return res.status(413).json({ statusCode: 413, message: 'Payload too large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ statusCode: 400, message: 'Malformed JSON' });

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
