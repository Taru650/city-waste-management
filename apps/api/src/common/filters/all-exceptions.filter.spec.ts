import { BadRequestException, HttpException } from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function run(exception: unknown) {
  const out: { status?: number; body?: unknown } = {};
  const res = { status: (s: number) => ((out.status = s), res), json: (b: unknown) => ((out.body = b), res) };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  const filter = new AllExceptionsFilter();
  const quiet = { error: () => undefined, warn: () => undefined };
  Object.assign(filter as unknown as { logger: object; deps: object }, { logger: quiet, deps: quiet });
  filter.catch(exception, host);
  return out;
}

const pgError = (code: string, message = 'x') => Object.assign(new Error(message), { code });

describe('AllExceptionsFilter', () => {
  it('passes HTTP errors through; a string message is wrapped so clients can read `message`', () => {
    expect(run(new BadRequestException('Bad date'))).toEqual({ status: 400, body: expect.objectContaining({ message: 'Bad date' }) });
    expect(run(new HttpException('Too many unfinished uploads', 429))).toEqual({ status: 429, body: { statusCode: 429, message: 'Too many unfinished uploads' } });
  });

  it.each([
    ['statement timeout', pgError('57014', 'canceling statement due to statement timeout')],
    ['pool wait', new Error('timeout exceeded when trying to connect')],
    ['database refused', pgError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432')],
    ['database restarting', pgError('57P03', 'the database system is starting up')],
    ['admin shutdown', pgError('57P01', 'terminating connection due to administrator command')],
    ['connection exception', pgError('08006', 'connection failure')],
    ['connection cut', new Error('Connection terminated unexpectedly')],
  ])('%s → 503, retryable, no internals leaked', (_n, err) => {
    const out = run(err);
    expect(out.status).toBe(503);
    expect(JSON.stringify(out.body)).not.toMatch(/5432|ECONN|statement|terminat|57P|08006/);
  });

  it('anything else is a bare 500 with no details', () => {
    expect(run(pgError('23505', 'duplicate key value violates unique constraint "users_mobile_hash_key"'))).toEqual({
      status: 500, body: { statusCode: 500, message: 'Internal server error' },
    });
    expect(run(new TypeError('x is undefined'))).toEqual({ status: 500, body: { statusCode: 500, message: 'Internal server error' } });
  });
});
