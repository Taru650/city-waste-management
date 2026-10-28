import { BadRequestException } from '@nestjs/common';

/**
 * Small embedded deny-list of the most common passwords (incl. India-specific ones), always on.
 * The full breached-password check is BreachedPasswordService (HIBP k-anonymity).
 */
const COMMON = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'password@123', 'password123',
  'qwerty123', 'qwertyuiop', 'iloveyou', 'abc12345', 'abcd1234', '11111111', '00000000', '88888888',
  'india123', 'india@123', 'bharat123', 'admin123', 'admin@123', 'welcome1', 'welcome@123',
  'sairam123', 'jaishreeram', 'jaihind123', 'krishna123', 'ganesh123', 'test1234', 'pass@123',
  'nagarnigam', 'nagarnigam1', 'changeme', 'letmein1', '1q2w3e4r', 'asdf1234', 'zaq12wsx',
]);

export const PASSWORD_MIN = 8;
/** Upper bound keeps Argon2 hashing cost bounded (DoS guard). */
export const PASSWORD_MAX = 128;

export function assertStrongPassword(password: string, context: { mobile?: string; email?: string } = {}) {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    problems.push(`must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) problems.push('must contain letters and digits');
  if (COMMON.has(password.toLowerCase())) problems.push('is too common');
  if (context.mobile && password.includes(context.mobile)) problems.push('must not contain your mobile number');
  const emailUser = context.email?.split('@')[0];
  if (emailUser && emailUser.length >= 4 && password.toLowerCase().includes(emailUser.toLowerCase())) {
    problems.push('must not contain your email name');
  }
  if (problems.length) throw new BadRequestException(`Password ${problems.join(', ')}`);
}
