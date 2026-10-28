import { db } from '@/db/connection';
import { query } from '@/db/sql';
import { ApiResult } from '@/middleware/route';

export const HealthController = {
  /** The process is up (does not touch the database). */
  live() {
    return { status: 'ok' };
  },

  /** Readiness for load balancers: the database answers. 503 (not a hang) when it does not. */
  async ready() {
    const started = Date.now();
    try {
      await Promise.race([
        query(db(), 'SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('database ping timed out')), 2_000).unref()),
      ]);
      return { status: 'ready', db: true, dbMs: Date.now() - started };
    } catch {
      return new ApiResult({ statusCode: 503, status: 'unavailable', db: false }, { status: 503 });
    }
  },
};
