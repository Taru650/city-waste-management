import { tooMany } from '@/lib/errors';

/**
 * Fixed-window rate limiter kept in this process's memory (fine for one server; with several servers each
 * counts separately: move the counters to a shared store before scaling out).
 */
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export function rateLimit(key: string, limit: number, windowMs = 60_000): void {
  const now = Date.now();
  if (now - lastSweep > windowMs) {
    lastSweep = now;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  b.count += 1;
  if (b.count > limit) {
    const err = tooMany('Too many requests, please slow down');
    (err as { retryAfter?: number }).retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    throw err;
  }
}

export function resetRateLimitsForTests() {
  buckets.clear();
}
