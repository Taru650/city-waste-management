import { Throttle } from '@nestjs/throttler';

/** Tighter per-IP limit for credential endpoints (brute force / credential stuffing). */
export const AuthThrottle = () =>
  Throttle({ default: { limit: () => Number(process.env.RATE_LIMIT_AUTH_PER_MIN ?? 10), ttl: 60_000 } });
