import { describe, expect, it } from 'vitest';
import { SEQ_MAX, buildComplaintNo, formatComplaintNo, normalizeComplaintNo } from '@/lib/complaintNumber';
import { COMPLAINT_STATUSES, ROLES } from '@/lib/enums';
import { templates } from '@/lib/notificationTemplates';
import { InvalidTransitionError, RULES, transition, type Actor, type TransitionAction } from '@/lib/stateMachine';

const ACTORS: Actor[] = [...ROLES, 'SYSTEM'];

describe('complaint state machine', () => {
  it.each([
    ['ROUTE', 'PENDING', 'SYSTEM', 'ASSIGNED'],
    ['ASSIGN', 'PENDING', 'SUB_ADMIN', 'ASSIGNED'],
    ['ASSIGN', 'ASSIGNED', 'SUPERVISOR', 'ASSIGNED'],
    ['ASSIGN', 'REOPENED', 'SUPERVISOR', 'ASSIGNED'],
    ['START', 'ASSIGNED', 'WORKER', 'WORK_IN_PROGRESS'],
    ['START', 'REOPENED', 'WORKER', 'WORK_IN_PROGRESS'],
    ['RESOLVE', 'WORK_IN_PROGRESS', 'WORKER', 'RESOLVED'],
    ['RESOLVE', 'ASSIGNED', 'SUPERVISOR', 'RESOLVED'],
    ['REJECT', 'PENDING', 'SUB_ADMIN', 'REJECTED'],
    ['MARK_DUPLICATE', 'ASSIGNED', 'SUPERVISOR', 'DUPLICATE'],
    ['CLOSE', 'RESOLVED', 'CITIZEN', 'CLOSED'],
    ['REOPEN', 'RESOLVED', 'CITIZEN', 'REOPENED'],
    ['AUTO_CLOSE', 'RESOLVED', 'SYSTEM', 'CLOSED'],
  ] as const)('%s from %s by %s gives %s', (action, from, actor, to) => {
    expect(transition(action, from, actor)).toBe(to);
  });

  it.each([
    ['RESOLVE', 'ASSIGNED', 'WORKER', 'a worker must start work before resolving'],
    ['ASSIGN', 'PENDING', 'WORKER', 'workers cannot assign'],
    ['ASSIGN', 'PENDING', 'CITIZEN', 'citizens cannot assign'],
    ['CLOSE', 'RESOLVED', 'SUPERVISOR', 'only the citizen closes via feedback'],
    ['REOPEN', 'CLOSED', 'CITIZEN', 'closed complaints stay closed'],
    ['REJECT', 'RESOLVED', 'SUPERVISOR', 'resolved complaints cannot be rejected'],
    ['START', 'PENDING', 'WORKER', 'unassigned complaints cannot be started'],
    ['ASSIGN', 'PENDING', 'DISTRICT_ADMIN', 'district admin is read-only'],
    ['ASSIGN', 'PENDING', 'WEB_ADMIN', 'web admin is read-only'],
  ] as const)('%s from %s by %s is refused (%s)', (action, from, actor, _why) => {
    expect(() => transition(action, from, actor)).toThrow(InvalidTransitionError);
  });

  it('nobody can move a complaint out of a closed, rejected or duplicate state', () => {
    for (const terminal of ['CLOSED', 'REJECTED', 'DUPLICATE'] as const) {
      for (const action of Object.keys(RULES) as TransitionAction[]) {
        for (const actor of ACTORS) expect(() => transition(action, terminal, actor), `${actor} ${action} ${terminal}`).toThrow(InvalidTransitionError);
      }
    }
  });

  it('every rule targets a known status and lists only known source statuses and actors', () => {
    for (const rule of Object.values(RULES)) {
      expect(COMPLAINT_STATUSES).toContain(rule.to);
      for (const [actor, froms] of Object.entries(rule.from)) {
        expect(ACTORS).toContain(actor);
        for (const f of froms!) expect(COMPLAINT_STATUSES).toContain(f);
      }
    }
  });

  it('only the system routes and auto-closes; only the citizen rates', () => {
    for (const actor of ACTORS) {
      if (actor !== 'SYSTEM') {
        expect(() => transition('ROUTE', 'PENDING', actor)).toThrow();
        expect(() => transition('AUTO_CLOSE', 'RESOLVED', actor)).toThrow();
      }
      if (actor !== 'CITIZEN') {
        expect(() => transition('CLOSE', 'RESOLVED', actor)).toThrow();
        expect(() => transition('REOPEN', 'RESOLVED', actor)).toThrow();
      }
    }
  });
});

describe('complaint numbers', () => {
  it('are 18 digits: district(4) ulb(6) year(2) sequence(6)', () => {
    expect(buildComplaintNo(446, 800123, 2026, 457)).toBe('044680012326000457');
    expect(buildComplaintNo(1, 1, 2099, SEQ_MAX)).toBe('000100000199999999');
    expect(formatComplaintNo('044680012326000457')).toBe('0446-800123-26-000457');
  });
  it.each([[0, 1, 1], [10000, 1, 1], [1.5, 1, 1], [1, 0, 1], [1, 1_000_000, 1], [1, 1, 0], [1, 1, SEQ_MAX + 1], [1, 1, 1.2]])('refuses out-of-range parts %s %s %s', (d, u, s) => {
    expect(() => buildComplaintNo(d, u, 2026, s)).toThrow(RangeError);
  });
  it('accepts the dashed or plain form when tracking, and nothing else', () => {
    expect(normalizeComplaintNo('0446-800123-26-000457')).toBe('044680012326000457');
    expect(normalizeComplaintNo('044680012326000457')).toBe('044680012326000457');
    for (const bad of ['', '123', '0446-800123-26-00045', '0446-800123-26-0004577', 'abcdefghijklmnopqr', "044680012326000457' OR 1=1", '044680012326000457\n', '0446 800123 26 000457']) {
      expect(normalizeComplaintNo(bad), bad).toBeNull();
    }
  });
});

describe('notification texts', () => {
  const NO = '044680012326000457';
  const all = Object.entries(templates).map(([name, fn]) => [name, (fn as (n: string, z?: string) => ReturnType<typeof templates.registered>)(NO, 'Mela Ground')] as const);

  it.each(all)('%s has Hindi and English text within the column limits', (_n, t) => {
    for (const lang of ['en', 'hi'] as const) {
      expect(t.title[lang].length).toBeGreaterThan(3);
      expect(t.title[lang].length).toBeLessThanOrEqual(120);
      expect(t.body[lang].length).toBeGreaterThan(3);
      expect(t.body[lang].length).toBeLessThanOrEqual(300);
    }
    expect(t.title.hi).toMatch(/[ऀ-ॿ]/);
    expect(t.type).toMatch(/^[A-Z_]+$/);
  });

  it.each(all.filter(([n]) => n !== 'mediaRejected'))('%s names the complaint by its public number only', (_n, t) => {
    expect(t.body.en).toContain('0446-800123-26-000457');
    expect(t.body.hi).toContain('0446-800123-26-000457');
    expect(`${t.title.en}${t.body.en}`).not.toMatch(/@|\b[6-9]\d{9}\b/); // no email or mobile number
  });
});
