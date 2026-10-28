import type { Knex } from 'knex';
import type { Db } from '@/db/sql';
import { one, query, run } from '@/db/sql';

export interface JobRow {
  id: number;
  queue: string;
  name: string;
  payload: unknown;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
  last_error: string | null;
}

export interface EnqueueOptions {
  /** Run no sooner than this many milliseconds from now (database clock). */
  delayMs?: number;
  maxAttempts?: number;
  /** At most one waiting or running job per key: asking again while one is waiting does nothing. */
  dedupeKey?: string;
}

export interface Lane {
  /** Only these queues. */
  queues?: string[];
  /** Every queue except these. */
  exclude?: string[];
}

const BACKOFF_SECONDS = [5, 30, 120, 600, 1800];

/** The background job table. Workers claim rows with FOR UPDATE SKIP LOCKED, so several workers never run one job twice. */
export const JobModel = {
  async enqueue(d: Db, queue: string, name: string, payload: unknown, o: EnqueueOptions = {}): Promise<void> {
    await run(
      d,
      `INSERT INTO jobs (queue, name, payload, run_at, max_attempts, dedupe_key)
       VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? MICROSECOND), ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [queue, name, payload === undefined ? null : JSON.stringify(payload), Math.round((o.delayMs ?? 0) * 1000), o.maxAttempts ?? 3, o.dedupeKey ?? null],
    );
  },

  /** Takes up to `limit` due jobs for this worker (marks them RUNNING and counts the attempt). */
  async claim(k: Knex, workerId: string, lane: Lane, limit: number): Promise<JobRow[]> {
    return k.transaction(async (trx) => {
      const filter = lane.queues?.length ? 'AND queue IN (?)' : lane.exclude?.length ? 'AND queue NOT IN (?)' : '';
      const params: unknown[] = [];
      if (filter) params.push(lane.queues?.length ? lane.queues : lane.exclude);
      params.push(limit);
      const ids = (await query<{ id: number }>(
        trx,
        // ORDER BY run_at only: that is the order of the index (status, run_at, queue), so MySQL stops after LIMIT rows and
        // locks only those. Adding "id" forces a filesort, and a filesort locks every pending row it reads.
        `SELECT id FROM jobs WHERE status = 'PENDING' AND run_at <= NOW(3) ${filter} ORDER BY run_at LIMIT ? FOR UPDATE SKIP LOCKED`,
        params,
      )).map((r) => r.id);
      if (!ids.length) return [];
      await run(trx, `UPDATE jobs SET status = 'RUNNING', locked_by = ?, locked_at = NOW(3), attempts = attempts + 1 WHERE id IN (?)`, [workerId, ids]);
      const rows = await query<JobRow>(trx, `SELECT id, queue, name, payload, status, attempts, max_attempts, dedupe_key, last_error FROM jobs WHERE id IN (?) ORDER BY run_at, id`, [ids]);
      return rows.map((r) => ({ ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }));
    });
  },

  async complete(d: Db, id: number): Promise<void> {
    await run(d, `UPDATE jobs SET status = 'DONE', finished_at = NOW(3), locked_by = NULL, last_error = NULL WHERE id = ?`, [id]);
  },

  /** Retry with growing delay until max_attempts, then FAILED. Returns true when it will run again. */
  async fail(d: Db, job: Pick<JobRow, 'id' | 'attempts' | 'max_attempts'>, error: string): Promise<boolean> {
    const retry = job.attempts < job.max_attempts;
    const delay = BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)];
    if (retry) {
      await run(d, `UPDATE jobs SET status = 'PENDING', run_at = DATE_ADD(NOW(3), INTERVAL ? SECOND), locked_by = NULL, last_error = ? WHERE id = ?`, [delay, error.slice(0, 2000), job.id]);
    } else {
      await run(d, `UPDATE jobs SET status = 'FAILED', finished_at = NOW(3), locked_by = NULL, last_error = ? WHERE id = ?`, [error.slice(0, 2000), job.id]);
    }
    return retry;
  },

  /** A worker that died mid-job leaves it RUNNING; put such jobs back (or fail them when out of attempts). */
  async recoverStale(d: Db, minutes: number): Promise<number> {
    const back = await run(d, `UPDATE jobs SET status = 'PENDING', locked_by = NULL, last_error = 'worker stopped while running this job' WHERE status = 'RUNNING' AND attempts < max_attempts AND locked_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE)`, [minutes]);
    const dead = await run(d, `UPDATE jobs SET status = 'FAILED', finished_at = NOW(3), locked_by = NULL, last_error = 'worker stopped while running this job' WHERE status = 'RUNNING' AND attempts >= max_attempts AND locked_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE)`, [minutes]);
    return back.affectedRows + dead.affectedRows;
  },

  async pruneFinished(d: Db, days: number): Promise<number> {
    const r = await run(d, `DELETE FROM jobs WHERE status IN ('DONE','FAILED') AND finished_at < DATE_SUB(NOW(3), INTERVAL ? DAY)`, [days]);
    return r.affectedRows;
  },

  async countByStatus(d: Db): Promise<Record<string, number>> {
    const rows = await query<{ status: string; n: number }>(d, `SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  },

  find(d: Db, id: number) {
    return one<JobRow>(d, `SELECT id, queue, name, payload, status, attempts, max_attempts, dedupe_key, last_error FROM jobs WHERE id = ?`, [id]);
  },
};
