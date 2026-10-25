import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Job, JobsOptions, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { setTimeout as sleep } from 'timers/promises';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

export const QUEUES = {
  /** Video transcoding (CPU heavy; scale worker replicas for peak events). */
  VIDEO: 'video',
  /** Push notification dispatch from the notifications outbox. */
  PUSH: 'push',
  /** Periodic housekeeping: SLA sweep, auto-close, orphan purge. */
  MAINTENANCE: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

type Handler = (job: Job) => Promise<unknown>;

interface Registration {
  handlers: Map<string, Handler>;
  concurrency: number;
}

interface Schedule {
  queue: QueueName;
  id: string;
  everyMs: number;
}

/**
 * Thin wrapper over BullMQ (Redis). Every process can enqueue; only processes with
 * PROCESS_ROLE=worker|all run workers and register the repeating schedules, so the
 * HTTP tier stays responsive while transcoding and sweeps run elsewhere.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly registrations = new Map<QueueName, Registration>();
  private readonly schedules: Schedule[] = [];
  private readonly workers: Worker[] = [];
  private readonly bootstrapHooks: (() => Promise<void>)[] = [];
  private readonly prefix = process.env.REDIS_PREFIX ?? 'cwm';

  private readonly redisWaitMs = Number(process.env.JOBS_REDIS_WAIT_MS ?? 2_000);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    // BullMQ requires maxRetriesPerRequest = null for blocking commands.
    this.connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    this.connection.on('error', (err) => this.logger.error(`Redis: ${err.message}`));
  }

  get runsWorkers(): boolean {
    return this.config.processRole !== 'api';
  }

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        prefix: this.prefix,
        defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  /**
   * Queues a job, giving up after a short wait. The Redis connection retries without limit (BullMQ
   * needs that), so while Redis is down an unbounded add() never settles, and a request awaiting
   * it hung after its database work had committed. The add itself stays queued in the client and
   * goes through once Redis is back; callers treat the rejection as "will happen later".
   */
  add(queue: QueueName, name: string, data: object, opts?: JobsOptions) {
    return withTimeout(this.queue(queue).add(name, data, opts), this.redisWaitMs, `Job queue unavailable (${queue}/${name})`);
  }

  /** Register a handler for `name` jobs on `queue`; started at application bootstrap. */
  process(queue: QueueName, name: string, handler: Handler, concurrency = 1) {
    const reg = this.registrations.get(queue) ?? { handlers: new Map(), concurrency };
    reg.handlers.set(name, handler);
    reg.concurrency = Math.max(reg.concurrency, concurrency);
    this.registrations.set(queue, reg);
  }

  /** Repeating job (idempotent upsert, so many replicas can declare the same schedule). */
  every(queue: QueueName, id: string, everyMs: number) {
    // JOBS_SCHEDULES=off lets tests drive sweeps explicitly instead of on a timer.
    if (process.env.JOBS_SCHEDULES === 'off') return;
    this.schedules.push({ queue, id, everyMs });
  }

  /** Work that should run once the worker side is up (e.g. re-enqueue interrupted jobs). */
  onWorkerStart(hook: () => Promise<void>) {
    this.bootstrapHooks.push(hook);
  }

  async onApplicationBootstrap() {
    if (!this.runsWorkers) return;
    for (const [queue, reg] of this.registrations) {
      const worker = new Worker(
        queue,
        async (job) => {
          const handler = reg.handlers.get(job.name);
          if (!handler) throw new Error(`No handler for ${queue}/${job.name}`);
          return handler(job);
        },
        { connection: this.connection, prefix: this.prefix, concurrency: reg.concurrency },
      );
      worker.on('failed', (job, err) => this.logger.warn(`${queue}/${job?.name} ${job?.id} failed: ${err.message}`));
      worker.on('error', (err) => this.logger.error(`${queue} worker: ${err.message}`));
      this.workers.push(worker);
    }
    for (const s of this.schedules) {
      await this.queue(s.queue).upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.id, data: {} });
    }
    for (const hook of this.bootstrapHooks) await hook();
  }

  /** Resolves when the queues have no waiting, active or delayed jobs (tests, graceful drain). */
  async waitForIdle(names: QueueName[], timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let pending = 0;
      for (const name of names) {
        const c = await this.queue(name).getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'paused');
        pending += Object.values(c).reduce((a, b) => a + b, 0);
      }
      if (pending === 0) return;
      if (Date.now() > deadline) throw new Error(`Queues ${names.join(',')} not idle after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Readiness: answers within the wait limit even while Redis is unreachable. */
  async ping(): Promise<boolean> {
    try {
      return (await withTimeout(this.connection.ping(), this.redisWaitMs, 'Redis ping timed out')) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    // Closing a worker whose Redis connections are still being set up leaves BullMQ emitting an
    // unhandled "Connection is closed" after its listeners are gone (a stop seconds after a start,
    // e.g. during a rolling deploy). Let them finish connecting first, but never wait long for it.
    await Promise.all(this.workers.map((w) => Promise.race([w.waitUntilReady().catch(() => undefined), sleep(5_000, undefined, { ref: false })])));
    // Each step is bounded: while Redis is unreachable a plain close()/quit() waits for a reconnect that
    // may never come, and the process never exited (stop timed out into a SIGKILL).
    const bounded = (p: Promise<unknown>) => withTimeout(p, 3_000, 'close timed out').catch(() => undefined);
    await Promise.all(this.workers.map((w) => bounded(w.close())));
    await Promise.all([...this.queues.values()].map((q) => bounded(q.close())));
    if (this.connection.status === 'ready') await bounded(this.connection.quit());
    this.connection.disconnect();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}
