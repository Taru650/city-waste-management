import { describe, expect, it } from 'vitest';
import { csrfOk } from './csrf';

const req = (method: string, headers: Record<string, string>) => new Request('http://portal.example/bff/api/x', { method, headers });

describe('csrfOk', () => {
  it('allows safe methods without the header', () => {
    expect(csrfOk(req('GET', {}))).toBe(true);
  });
  it('allows same-origin POST with the custom header', () => {
    expect(csrfOk(req('POST', { 'x-cwm-csrf': '1', origin: 'http://portal.example', host: 'portal.example' }))).toBe(true);
    expect(csrfOk(req('POST', { 'x-cwm-csrf': '1', 'sec-fetch-site': 'same-origin', host: 'portal.example' }))).toBe(true);
  });
  it.each([
    ['no custom header', { origin: 'http://portal.example', host: 'portal.example' }],
    ['cross-site origin', { 'x-cwm-csrf': '1', origin: 'https://evil.example', host: 'portal.example' }],
    ['cross-site fetch metadata', { 'x-cwm-csrf': '1', 'sec-fetch-site': 'cross-site', host: 'portal.example' }],
    ['null origin (sandboxed iframe)', { 'x-cwm-csrf': '1', origin: 'null', host: 'portal.example' }],
  ])('rejects POST with %s', (_n, headers) => {
    expect(csrfOk(req('POST', headers as Record<string, string>))).toBe(false);
  });
});
