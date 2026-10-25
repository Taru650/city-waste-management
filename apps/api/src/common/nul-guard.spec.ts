import { containsNul, nulGuard } from './nul-guard';

describe('NUL guard', () => {
  it('finds NUL in nested strings and keys, not elsewhere', () => {
    expect(containsNul({ a: [{ b: 'x\u0000' }] })).toBe(true);
    expect(containsNul({ ['k\u0000']: 1 })).toBe(true);
    expect(containsNul({ a: ['ok', 1, null, { b: 'fine' }] })).toBe(false);
    expect(containsNul('शिकायत')).toBe(false);
  });

  it('refuses the request (400) for body, query or encoded path', () => {
    const run = (req: { url: string; query?: unknown; body?: unknown }) => {
      let status = 0;
      let passed = false;
      nulGuard(req, { status: (c) => ((status = c), { json: () => undefined }) }, () => (passed = true));
      return passed ? 'next' : status;
    };
    expect(run({ url: '/api/v1/x', body: { t: 'a\u0000' } })).toBe(400);
    expect(run({ url: '/api/v1/x', query: { s: '\u0000' } })).toBe(400);
    expect(run({ url: '/api/v1/x%00y' })).toBe(400);
    expect(run({ url: '/api/v1/x', body: { t: 'ok' } })).toBe('next');
    expect(run({ url: '/api/v1/%E0%A4' })).toBe('next'); // malformed escape: left to the router
  });
});
