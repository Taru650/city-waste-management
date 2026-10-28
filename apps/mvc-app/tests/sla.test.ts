import { spawn } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRunner } from '@/jobs/registry';
import { newId } from '@/lib/ids';
import { ComplaintModel } from '@/models/ComplaintModel';
import { NotificationService } from '@/services/NotificationService';
import { SlaService } from '@/services/SlaService';
import { createJurisdiction, createUser, db, one, query, run, setupTestEnvironment, type Jurisdiction } from './helpers';

setupTestEnvironment();

let j: Jurisdiction;
let typeId: string;
let slaHours: number;
let supervisor: string;
let worker: string;
let subAdmin: string;
let citizen: string;
let counter = 0;

beforeAll(async () => {
  j = await createJurisdiction();
  const t = (await one(db(), `SELECT id, sla_hours FROM complaint_types WHERE active ORDER BY sort_order LIMIT 1`))!;
  typeId = t.id;
  slaHours = t.sla_hours;
  supervisor = (await createUser('SUPERVISOR', j)).id;
  worker = (await createUser('WORKER', j)).id;
  subAdmin = (await createUser('SUB_ADMIN', j)).id;
  citizen = (await createUser('CITIZEN', j)).id;
});

interface Opts {
  status?: string;
  /** Hours since the deadline (negative: the deadline is still ahead). */
  overdueHours?: number;
  supervisorId?: string | null;
  workerId?: string | null;
}

/** A complaint inserted directly: the sweeper only looks at the row, so no photo or routing is needed. */
async function complaint(o: Opts = {}): Promise<string> {
  const id = newId();
  counter += 1;
  const no = `9${String(Date.now()).slice(-9)}${String(counter).padStart(8, '0')}`.slice(0, 18);
  const c = j.wards[0].center;
  await run(
    db(),
    `INSERT INTO complaints (id, complaint_no, citizen_id, district_id, ulb_id, ward_id, area_id, ward_source, type_id, description, location, status, supervisor_id, worker_id, sla_due_at)
     VALUES (?,?,?,?,?,?,?, 'GPS', ?, 'Garbage heap near the school gate', ST_PointFromText(?, 4326, 'axis-order=long-lat'), ?, ?, ?, DATE_SUB(NOW(3), INTERVAL ? MINUTE))`,
    [
      id, no, citizen, j.districtId, j.ulbId, j.wards[0].id, j.areaId, typeId, `POINT(${c.lng} ${c.lat})`, o.status ?? 'ASSIGNED',
      o.supervisorId === undefined ? supervisor : o.supervisorId, o.workerId === undefined ? worker : o.workerId, Math.round((o.overdueHours ?? 1) * 60),
    ],
  );
  return id;
}
const row = (id: string) => one(db(), `SELECT * FROM complaints WHERE id = ?`, [id]);
const events = async (id: string, action: string) => query(db(), `SELECT action, from_status, to_status, actor_id, remark FROM complaint_events WHERE complaint_id = ? AND action = ?`, [id, action]);
const notices = async (userId: string, id: string) => (await query<{ type: string }>(db(), `SELECT type FROM notifications WHERE user_id = ? AND complaint_id = ? ORDER BY created_at, id`, [userId, id])).map((r) => r.type);

describe('deadline breaches', () => {
  it('marks an overdue open complaint once, writes a timeline entry, and tells the supervisor and the worker', async () => {
    const id = await complaint({ overdueHours: 1, status: 'WORK_IN_PROGRESS' });
    const result = await SlaService.sweep();
    expect(result.breached).toBeGreaterThanOrEqual(1);
    const c = (await row(id))!;
    expect(c.sla_breached_at).toBeTruthy();
    expect(c.escalated).toBeFalsy();
    expect(await events(id, 'SLA_BREACH')).toEqual([{ action: 'SLA_BREACH', from_status: 'WORK_IN_PROGRESS', to_status: 'WORK_IN_PROGRESS', actor_id: null, remark: 'Resolution deadline passed' }]);
    expect(await notices(supervisor, id)).toEqual(['SLA_BREACHED']);
    expect(await notices(worker, id)).toEqual(['SLA_BREACHED']);
    expect(await notices(subAdmin, id)).toEqual([]);
    const again = await SlaService.sweep();
    expect(again.breached).toBe(0); // nothing is repeated
    expect(await events(id, 'SLA_BREACH')).toHaveLength(1);
    expect(await notices(supervisor, id)).toHaveLength(1);
  });

  it('goes to the Sub Admins when nobody has been assigned yet', async () => {
    const id = await complaint({ status: 'PENDING', supervisorId: null, workerId: null });
    await SlaService.sweep();
    expect(await notices(subAdmin, id)).toEqual(['SLA_BREACHED']);
    expect(await notices(supervisor, id)).toEqual([]);
  });

  it.each([
    ['not yet due', { overdueHours: -2 }],
    ['resolved', { status: 'RESOLVED' }],
    ['closed', { status: 'CLOSED' }],
    ['rejected', { status: 'REJECTED' }],
    ['a duplicate', { status: 'DUPLICATE' }],
  ] as const)('leaves a complaint that is %s alone', async (_name, opts) => {
    const id = await complaint(opts);
    await SlaService.sweep();
    expect((await row(id))!.sla_breached_at).toBeNull();
    expect(await events(id, 'SLA_BREACH')).toHaveLength(0);
  });

  it('a reopened complaint can breach again after its deadline is reset', async () => {
    const id = await complaint({ overdueHours: 1 });
    await SlaService.sweep();
    expect(await events(id, 'SLA_BREACH')).toHaveLength(1);
    await run(db(), `UPDATE complaints SET status = 'RESOLVED', resolved_at = NOW(3) WHERE id = ?`, [id]);
    await ComplaintModel.setReopened(db(), id, false, typeId);
    const reopened = (await row(id))!;
    expect(reopened.sla_breached_at).toBeNull();
    expect(new Date(reopened.sla_due_at).getTime()).toBeGreaterThan(Date.now());
    await SlaService.sweep();
    expect(await events(id, 'SLA_BREACH')).toHaveLength(1); // not due again yet
    await run(db(), `UPDATE complaints SET sla_due_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id = ?`, [id]);
    await SlaService.sweep();
    expect(await events(id, 'SLA_BREACH')).toHaveLength(2);
  });
});

describe('escalation at twice the SLA', () => {
  it('escalates once a whole SLA has passed after the deadline, and tells the Sub Admins', async () => {
    const justBreached = await complaint({ overdueHours: slaHours - 0.1 });
    const waited = await complaint({ overdueHours: slaHours + 0.1 });
    await SlaService.sweep();
    expect((await row(justBreached))!.escalated).toBeFalsy();
    expect((await row(justBreached))!.sla_breached_at).toBeTruthy();
    const e = (await row(waited))!;
    expect(e.escalated).toBeTruthy();
    expect(e.escalated_at).toBeTruthy();
    expect(e.sla_breached_at).toBeTruthy(); // late and escalated in the same pass
    expect(await events(waited, 'ESCALATE')).toEqual([{ action: 'ESCALATE', from_status: 'ASSIGNED', to_status: 'ASSIGNED', actor_id: null, remark: 'Unresolved at twice the SLA' }]);
    expect(await notices(subAdmin, waited)).toEqual(['ESCALATED']);
    await SlaService.sweep();
    expect(await events(waited, 'ESCALATE')).toHaveLength(1);
    expect(await notices(subAdmin, waited)).toHaveLength(1);
    expect((await row(justBreached))!.escalated).toBeFalsy();
  });
});

describe('many complaints and many sweepers', () => {
  it('works through large backlogs in batches without missing or repeating any', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await complaint({ overdueHours: 2 }));
    const result = await SlaService.sweep(3);
    expect(result.breached).toBeGreaterThanOrEqual(8);
    for (const id of ids) {
      expect((await row(id))!.sla_breached_at).toBeTruthy();
      expect(await events(id, 'SLA_BREACH')).toHaveLength(1);
    }
  });

  it('two sweepers at the same moment handle each complaint exactly once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await complaint({ overdueHours: 2 }));
    await Promise.all([SlaService.sweep(4), SlaService.sweep(4), SlaService.sweep(4)]);
    for (const id of ids) {
      expect(await events(id, 'SLA_BREACH'), id).toHaveLength(1);
      expect(await notices(supervisor, id), id).toHaveLength(1);
    }
  });

  it('leaves a complaint someone is changing right now for the next pass', async () => {
    const busy = await complaint({ overdueHours: 2 });
    const free = await complaint({ overdueHours: 2 });
    const holder = await db().transaction();
    try {
      await query(holder, `SELECT id FROM complaints WHERE id = ? FOR UPDATE`, [busy]);
      await SlaService.sweep();
      expect((await row(free))!.sla_breached_at).toBeTruthy();
      expect((await row(busy))!.sla_breached_at).toBeNull(); // skipped, not waited for
    } finally {
      await holder.rollback();
    }
    await SlaService.sweep();
    expect((await row(busy))!.sla_breached_at).toBeTruthy();
    expect(await events(busy, 'SLA_BREACH')).toHaveLength(1);
  });
});

describe('the background jobs', () => {
  it('every timed job runs once when started, reschedules itself, and never queues twice', async () => {
    await run(db(), 'DELETE FROM jobs');
    const id = await complaint({ overdueHours: 3 });
    const runner = createRunner();
    await runner.ensurePeriodic();
    await runner.ensurePeriodic();
    const names = (await query<{ name: string }>(db(), `SELECT name FROM jobs WHERE status = 'PENDING' ORDER BY name`)).map((r) => r.name);
    expect(names).toEqual(['auto-close', 'privacy-purge', 'prune-jobs', 'purge-media', 'push-dispatch', 'requeue-videos', 'sla-sweep', 'zone-handover']);

    // eight timed jobs, plus the push dispatch that the SLA sweep queued for the notifications it wrote
    expect(await runner.runDue({ exclude: ['video'] })).toBe(9);
    expect((await row(id))!.sla_breached_at).toBeTruthy(); // the SLA job did its work
    const done = (await query<{ name: string }>(db(), `SELECT name FROM jobs WHERE status = 'DONE' ORDER BY name`)).map((r) => r.name);
    expect(done).toEqual(['auto-close', 'dispatch', 'privacy-purge', 'prune-jobs', 'purge-media', 'push-dispatch', 'requeue-videos', 'sla-sweep', 'zone-handover']);
    const next = await query<{ name: string; far: number }>(db(), `SELECT name, run_at > DATE_ADD(NOW(3), INTERVAL 20 SECOND) AS far FROM jobs WHERE status = 'PENDING'`);
    expect(next).toHaveLength(8);
    expect(next.every((n) => n.far)).toBe(true);
    expect(await runner.runDue({ exclude: ['video'] })).toBe(0);
  });

  it('a notification kick is delivered by the push job', async () => {
    await run(db(), 'DELETE FROM jobs');
    const user = (await createUser('CITIZEN', j)).id;
    await NotificationService.notify(db(), [user], { type: 'TEST', title: { en: 'Hello', hi: 'नमस्ते' }, body: { en: 'Hello there', hi: 'नमस्ते जी' } });
    await NotificationService.kick();
    expect(await createRunner().runDue({ exclude: ['video'] })).toBe(1);
    expect((await one(db(), `SELECT push_status FROM notifications WHERE user_id = ?`, [user]))!.push_status).toBe('SKIPPED'); // push is off in tests
  });
});

describe('the worker process', () => {
  it('starts on its own, picks up work from the queue, and stops cleanly when asked', async () => {
    await run(db(), 'DELETE FROM jobs');
    const user = (await createUser('CITIZEN', j)).id;
    await NotificationService.notify(db(), [user], { type: 'TEST', title: { en: 'Hi', hi: 'नमस्ते' }, body: { en: 'Hi there', hi: 'नमस्ते जी' } });
    await NotificationService.kick();

    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/worker.ts'], { env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      const deadline = Date.now() + 30_000;
      let handled = false;
      while (Date.now() < deadline && !handled) {
        await new Promise((r) => setTimeout(r, 300));
        handled = (await one(db(), `SELECT push_status FROM notifications WHERE user_id = ?`, [user]))!.push_status !== 'PENDING';
      }
      expect(handled, `the worker did not deliver the notification. Output:\n${output}`).toBe(true);
      expect(output).toContain('[worker] started');
      // its timed jobs are scheduled
      const scheduled = await query(db(), `SELECT DISTINCT name FROM jobs WHERE dedupe_key LIKE 'periodic:%'`);
      expect(scheduled.length).toBeGreaterThanOrEqual(8);
    } finally {
      child.kill('SIGTERM');
    }
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 15_000))]);
    expect(code, `output:\n${output}`).toBe(0);
    expect(output).toContain('[worker] stopped');
    expect(await query(db(), `SELECT id FROM jobs WHERE status = 'RUNNING'`)).toHaveLength(0); // nothing left half-done
  }, 90_000);
});
