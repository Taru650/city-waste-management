import { describe, expect, it } from 'vitest';
import { isBlocked } from './proxy-rules';

const p = (path: string) => path.split('/');

describe('BFF proxy rules', () => {
  it.each(['auth/me', 'auth/logout-all', 'auth/mfa/recovery-codes', 'auth/me/preferences', 'complaints', 'reports/summary', 'notifications/read-all'])(
    'allows %s',
    (path) => expect(isBlocked(p(path))).toBe(false),
  );

  it.each([
    'auth/login', 'auth/refresh', 'auth/logout', 'auth/change-password', 'auth/mfa/verify', 'auth/mfa/recover',
    'media/upload-url', 'devices', 'devices/abc', 'attestation/challenge', 'Attestation/Challenge/',
    // bypass attempts: Express is case-insensitive and tolerant of slashes
    'AUTH/login', 'Auth/Refresh', 'auth/login/', 'auth//login', 'auth/./login', 'auth%2Flogin', 'MEDIA/x',
    // traversal
    'complaints/../auth/login', 'reports/%2e%2e/auth/refresh',
  ])('blocks %s', (path) => expect(isBlocked(p(path))).toBe(true));
});
