import { BadRequestException } from '@nestjs/common';
import { assertStrongPassword } from './password-policy';

describe('password policy', () => {
  it('accepts a reasonable password', () => {
    expect(() => assertStrongPassword('Swachh#2026city')).not.toThrow();
  });

  it.each([
    ['short1A', 'too short'],
    ['a'.repeat(129) + '1', 'too long (argon2 DoS guard)'],
    ['onlyletters', 'no digits'],
    ['1234567890123', 'no letters'],
    ['Password@123', 'common password'],
    ['nagarnigam1', 'common local password'],
  ])('rejects %p (%s)', (pw) => {
    expect(() => assertStrongPassword(pw)).toThrow(BadRequestException);
  });

  it('rejects passwords containing the mobile number or email name', () => {
    expect(() => assertStrongPassword('ab9876543210', { mobile: '9876543210' })).toThrow(BadRequestException);
    expect(() => assertStrongPassword('ramesh2026xy', { email: 'ramesh@example.com' })).toThrow(BadRequestException);
  });
});
