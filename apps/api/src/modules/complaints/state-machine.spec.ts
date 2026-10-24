import { ComplaintStatus as S, Role } from '../../common/enums';
import { Actor, ComplaintAction as A, InvalidTransitionError, RULES, transition } from './state-machine';

const ALL_STATUSES = Object.values(S);
const ALL_ACTORS: Actor[] = [...Object.values(Role), 'SYSTEM'];

describe('complaint state machine', () => {
  it.each([
    [A.ROUTE, S.PENDING, 'SYSTEM', S.ASSIGNED],
    [A.ASSIGN, S.PENDING, Role.SUB_ADMIN, S.ASSIGNED],
    [A.ASSIGN, S.ASSIGNED, Role.SUPERVISOR, S.ASSIGNED],
    [A.ASSIGN, S.REOPENED, Role.SUPERVISOR, S.ASSIGNED],
    [A.START, S.ASSIGNED, Role.WORKER, S.WORK_IN_PROGRESS],
    [A.START, S.REOPENED, Role.WORKER, S.WORK_IN_PROGRESS],
    [A.RESOLVE, S.WORK_IN_PROGRESS, Role.WORKER, S.RESOLVED],
    [A.RESOLVE, S.ASSIGNED, Role.SUPERVISOR, S.RESOLVED],
    [A.REJECT, S.PENDING, Role.SUB_ADMIN, S.REJECTED],
    [A.MARK_DUPLICATE, S.ASSIGNED, Role.SUPERVISOR, S.DUPLICATE],
    [A.CLOSE, S.RESOLVED, Role.CITIZEN, S.CLOSED],
    [A.REOPEN, S.RESOLVED, Role.CITIZEN, S.REOPENED],
    [A.AUTO_CLOSE, S.RESOLVED, 'SYSTEM', S.CLOSED],
  ] as const)('%s from %s by %s → %s', (action, from, actor, to) => {
    expect(transition(action, from, actor)).toBe(to);
  });

  it.each([
    [A.RESOLVE, S.ASSIGNED, Role.WORKER, 'worker must start work before resolving'],
    [A.ASSIGN, S.PENDING, Role.WORKER, 'workers cannot assign'],
    [A.ASSIGN, S.PENDING, Role.CITIZEN, 'citizens cannot assign'],
    [A.CLOSE, S.RESOLVED, Role.SUPERVISOR, 'only the citizen closes via feedback'],
    [A.REOPEN, S.CLOSED, Role.CITIZEN, 'closed complaints cannot be reopened'],
    [A.REJECT, S.RESOLVED, Role.SUPERVISOR, 'resolved complaints cannot be rejected'],
    [A.START, S.PENDING, Role.WORKER, 'unassigned complaints cannot be started'],
    [A.ASSIGN, S.PENDING, Role.DISTRICT_ADMIN, 'district admin is read-only'],
    [A.ASSIGN, S.PENDING, Role.WEB_ADMIN, 'web admin is read-only'],
  ] as const)('%s from %s by %s is refused (%s)', (action, from, actor, _why) => {
    expect(() => transition(action, from, actor)).toThrow(InvalidTransitionError);
  });

  it('no actor can move a complaint out of a terminal state except by reopen of RESOLVED', () => {
    for (const terminal of [S.CLOSED, S.REJECTED, S.DUPLICATE]) {
      for (const action of Object.keys(RULES) as (keyof typeof RULES)[]) {
        for (const actor of ALL_ACTORS) {
          expect(() => transition(action, terminal, actor)).toThrow(InvalidTransitionError);
        }
      }
    }
  });

  it('every rule targets a known status and only lists known source statuses', () => {
    for (const rule of Object.values(RULES)) {
      expect(ALL_STATUSES).toContain(rule.to);
      for (const froms of Object.values(rule.from)) for (const f of froms!) expect(ALL_STATUSES).toContain(f);
    }
  });
});
