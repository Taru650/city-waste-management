import { randomUUID } from 'node:crypto';
import { db } from '@/db/connection';
import { JobModel, type JobRow, type Lane } from '@/models/JobModel';

export type JobHandler = (payload: any, job: JobRow) => Promise<unknown> | unknown;

const POLL_MS = 1_000;
const STALE_MINUTES = 15;

interface Periodic {
  queue: string;
  name: string;
  everyMs: number;
  key: string;
}

/**
 * Runs the jobs in the MySQL job table. One handler per "queue:name". Periodic jobs re-schedule themselves
 * after every run, so they survive restarts and several workers never run the same tick twice.
 */
export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly periodic = new Map<string, Periodic>();
  private readonly workerId = `w-${process.pid}-${randomUUID().slice(0, 8)}`;
  private stopped = true;
  private loops: Promise<void>[] = [];
  private lastEnsure = 0;

  register(queue: string, name: string, handler: JobHandler): this {
    this.handlers.set(`${queue}:${name}`, handler);
    return this;
  }

  /** Run `queue:name` every `everyMs` (the handler must be registered too). */
  every(queue: string, name: string, everyMs: number): this {
    const key = `periodic:${queue}:${name}`;
    this.periodic.set(key, { queue, name, everyMs, key });
    return this;
  }

  /** Makes sure every periodic job has a waiting run (no-op when it already does). */
  async ensurePeriodic(): Promise<void> {
    for (const p of this.periodic.values()) {
      await JobModel.enqueue(db(), p.queue, p.name, {}, { dedupeKey: p.key, maxAttempts: 1 });
    }
  }

  /** Runs due jobs one after another until none are due (or `limit` ran). Used by tests and by the poll loops. */
  async runDue(lane: Lane = {}, limit = 100): Promise<number> {
    let ran = 0;
    while (ran < limit) {
      const [job] = await JobModel.claim(db(), this.workerId, lane, 1);
      if (!job) break;
      await this.execute(job);
      ran += 1;
    }
    return ran;
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.handlers.get(`${job.queue}:${job.name}`);
    const p = job.dedupe_key ? this.periodic.get(job.dedupe_key) : undefined;
    let willRetry = false;
    try {
      if (!handler) throw new Error(`no handler registered for ${job.queue}:${job.name}`);
      await handler(job.payload, job);
      await JobModel.complete(db(), job.id);
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`[jobs] ${job.queue}:${job.name} #${job.id} failed (attempt ${job.attempts}/${job.max_attempts}): ${message}`);
      willRetry = await JobModel.fail(db(), job, message);
    }
    if (p && !willRetry) await JobModel.enqueue(db(), p.queue, p.name, {}, { dedupeKey: p.key, delayMs: p.everyMs, maxAttempts: 1 });
  }

  /** Starts polling: one slot for video (heavy), several for everything else. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const lanes: { lane: Lane; slots: number }[] = [
      { lane: { queues: ['video'] }, slots: 1 },
      { lane: { exclude: ['video'] }, slots: 3 },
    ];
    for (const { lane, slots } of lanes) {
      for (let i = 0; i < slots; i++) this.loops.push(this.loop(lane));
    }
  }

  private async loop(lane: Lane): Promise<void> {
    while (!this.stopped) {
      try {
        if (Date.now() - this.lastEnsure > 60_000) {
          this.lastEnsure = Date.now();
          await JobModel.recoverStale(db(), STALE_MINUTES);
          await this.ensurePeriodic();
        }
        const ran = await this.runDue(lane, 10);
        if (ran === 0) await new Promise((r) => setTimeout(r, POLL_MS));
      } catch (err) {
        console.error('[jobs] runner error:', (err as Error).message);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.loops);
    this.loops = [];
  }
}
