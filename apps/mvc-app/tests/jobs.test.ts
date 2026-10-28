import { beforeEach, describe, expect, it } from 'vitest';
import { JobRunner } from '@/jobs/runner';
import { JobQueue } from '@/jobs/queue';
import { JobModel } from '@/models/JobModel';
import { db, one, query, run, setupTestEnvironment } from './helpers';

setupTestEnvironment();
beforeEach(async () => {
  await run(db(), 'DELETE FROM jobs');
});

const rows = () => query(db(), 'SELECT * FROM jobs ORDER BY id');
const makeDue = (id?: number) => run(db(), `UPDATE jobs SET run_at = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE status = 'PENDING'${id ? ' AND id = ?' : ''}`, id ? [id] : []);

describe('job queue', () => {
  it('runs a due job with its payload and marks it done', async () => {
    const seen: unknown[] = [];
    const runner = new JobRunner().register('maintenance', 'hello', (p) => void seen.push(p));
    await JobQueue.add('maintenance', 'hello', { n: 7, text: 'नमस्ते' });
    expect(await runner.runDue()).toBe(1);
    expect(seen).toEqual([{ n: 7, text: 'नमस्ते' }]);
    expect((await rows())[0]).toEqual(expect.objectContaining({ status: 'DONE', attempts: 1 }));
    expect(await runner.runDue()).toBe(0);
  });

  it('does not run a job before it is due', async () => {
    const runner = new JobRunner().register('maintenance', 'later', () => undefined);
    await JobQueue.add('maintenance', 'later', {}, { delayMs: 60_000 });
    expect(await runner.runDue()).toBe(0);
    await makeDue();
    expect(await runner.runDue()).toBe(1);
  });

  it('keeps one waiting job per dedupe key, and allows a new one once the first has run', async () => {
    const runner = new JobRunner().register('push', 'dispatch', () => undefined);
    for (let i = 0; i < 5; i++) await JobQueue.add('push', 'dispatch', {}, { dedupeKey: 'push-dispatch' });
    expect(await rows()).toHaveLength(1);
    await runner.runDue();
    await JobQueue.add('push', 'dispatch', {}, { dedupeKey: 'push-dispatch' });
    expect(await rows()).toHaveLength(2);
    // jobs without a key are never merged
    await JobQueue.add('push', 'other');
    await JobQueue.add('push', 'other');
    expect(await rows()).toHaveLength(4);
  });

  it('retries a failing job with a growing delay, records the error, and gives up after max attempts', async () => {
    let calls = 0;
    const runner = new JobRunner().register('maintenance', 'flaky', () => {
      calls += 1;
      throw new Error('boom');
    });
    await JobQueue.add('maintenance', 'flaky', {}, { maxAttempts: 3 });
    expect(await runner.runDue()).toBe(1);
    let job = (await rows())[0];
    expect(job).toEqual(expect.objectContaining({ status: 'PENDING', attempts: 1 }));
    expect(job.last_error).toContain('boom');
    expect(await runner.runDue()).toBe(0); // backoff: not due yet
    await makeDue();
    await runner.runDue();
    job = (await rows())[0];
    expect(job).toEqual(expect.objectContaining({ status: 'PENDING', attempts: 2 }));
    await makeDue();
    await runner.runDue();
    job = (await rows())[0];
    expect(job).toEqual(expect.objectContaining({ status: 'FAILED', attempts: 3 }));
    expect(calls).toBe(3);
    await makeDue();
    expect(await runner.runDue()).toBe(0);
  });

  it('a job nobody can handle fails instead of disappearing', async () => {
    const runner = new JobRunner();
    await JobQueue.add('maintenance', 'unknown', {}, { maxAttempts: 1 });
    await runner.runDue();
    expect((await rows())[0]).toEqual(expect.objectContaining({ status: 'FAILED' }));
    expect((await rows())[0].last_error).toMatch(/no handler/);
  });

  it('many workers claiming at once never take the same job twice', async () => {
    for (let i = 0; i < 60; i++) await JobQueue.add('maintenance', 'n', { i });
    const claimedBy = await Promise.all(Array.from({ length: 8 }, async (_, w) => {
      const mine: number[] = [];
      for (;;) {
        const got = await JobModel.claim(db(), `worker-${w}`, {}, 4);
        if (!got.length) return mine;
        mine.push(...got.map((j) => j.id));
      }
    }));
    const all = claimedBy.flat();
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
  });

  it('a claimer skips a job another worker is holding instead of waiting for it', async () => {
    for (let i = 0; i < 3; i++) await JobQueue.add('maintenance', 'n', { i });
    const holder = await db().transaction();
    try {
      const [held] = await query<{ id: number }>(holder, `SELECT id FROM jobs WHERE status = 'PENDING' ORDER BY run_at LIMIT 1 FOR UPDATE`);
      const started = Date.now();
      const got = await JobModel.claim(db(), 'other-worker', {}, 5);
      expect(Date.now() - started).toBeLessThan(2_000); // did not queue behind the lock
      expect(got).toHaveLength(2);
      expect(got.map((j) => j.id)).not.toContain(held.id);
    } finally {
      await holder.rollback();
    }
  });

  it('lanes keep heavy video work apart from the rest', async () => {
    await JobQueue.add('video', 'transcode');
    await JobQueue.add('push', 'dispatch');
    const videoOnly = await JobModel.claim(db(), 'w', { queues: ['video'] }, 10);
    expect(videoOnly.map((j) => j.queue)).toEqual(['video']);
    const rest = await JobModel.claim(db(), 'w', { exclude: ['video'] }, 10);
    expect(rest.map((j) => j.queue)).toEqual(['push']);
  });

  it('puts back jobs a dead worker left running, and fails those out of attempts', async () => {
    await JobQueue.add('maintenance', 'a', {}, { maxAttempts: 3 });
    await JobQueue.add('maintenance', 'b', {}, { maxAttempts: 1 });
    await JobModel.claim(db(), 'dead-worker', {}, 10);
    expect(await JobModel.recoverStale(db(), 15)).toBe(0); // only just started
    await run(db(), `UPDATE jobs SET locked_at = DATE_SUB(NOW(3), INTERVAL 20 MINUTE) WHERE status = 'RUNNING'`);
    expect(await JobModel.recoverStale(db(), 15)).toBe(2);
    const byName = Object.fromEntries((await rows()).map((r) => [r.name, r.status]));
    expect(byName).toEqual({ a: 'PENDING', b: 'FAILED' });
  });

  it('periodic jobs re-schedule themselves after each run, even after a failure, and never pile up', async () => {
    let runs = 0;
    let failNext = false;
    const runner = new JobRunner()
      .register('maintenance', 'tick', () => {
        runs += 1;
        if (failNext) throw new Error('tick failed');
      })
      .every('maintenance', 'tick', 3_600_000);
    await runner.ensurePeriodic();
    await runner.ensurePeriodic();
    expect((await rows()).filter((r) => r.status === 'PENDING')).toHaveLength(1);

    await runner.runDue();
    expect(runs).toBe(1);
    const next = (await rows()).filter((r) => r.status === 'PENDING');
    expect(next).toHaveLength(1);
    const due = await one(db(), `SELECT run_at > DATE_ADD(NOW(3), INTERVAL 59 MINUTE) AS far FROM jobs WHERE status = 'PENDING'`);
    expect(due!.far).toBeTruthy(); // next run is an hour away
    expect(await runner.runDue()).toBe(0);

    failNext = true;
    await makeDue();
    await runner.runDue();
    expect(runs).toBe(2);
    expect((await rows()).filter((r) => r.status === 'PENDING')).toHaveLength(1); // still scheduled
    await runner.ensurePeriodic();
    expect((await rows()).filter((r) => r.status === 'PENDING')).toHaveLength(1);
  });

  it('removes old finished jobs but keeps recent ones and live ones', async () => {
    await JobQueue.add('maintenance', 'old');
    await JobQueue.add('maintenance', 'recent');
    await JobQueue.add('maintenance', 'waiting');
    const runner = new JobRunner().register('maintenance', 'old', () => undefined).register('maintenance', 'recent', () => undefined);
    await runner.runDue({ queues: ['maintenance'] }, 2);
    await run(db(), `UPDATE jobs SET finished_at = DATE_SUB(NOW(3), INTERVAL 30 DAY) WHERE name = 'old'`);
    expect(await JobModel.pruneFinished(db(), 7)).toBe(1);
    expect((await rows()).map((r) => r.name).sort()).toEqual(['recent', 'waiting']);
  });
});
