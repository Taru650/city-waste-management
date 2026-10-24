import { ComplaintStatus as S, Role } from '../../common/enums';

export enum ComplaintAction {
  CREATE = 'CREATE',
  ROUTE = 'ROUTE',
  ASSIGN = 'ASSIGN',
  START = 'START',
  RESOLVE = 'RESOLVE',
  REJECT = 'REJECT',
  MARK_DUPLICATE = 'MARK_DUPLICATE',
  CLOSE = 'CLOSE',
  REOPEN = 'REOPEN',
  AUTO_CLOSE = 'AUTO_CLOSE',
  /** Timeline-only events (no status change), written by the SLA sweeper. */
  SLA_BREACH = 'SLA_BREACH',
  ESCALATE = 'ESCALATE',
}

/** 'SYSTEM' = background jobs and automatic routing. */
export type Actor = Role | 'SYSTEM';

interface Rule {
  to: S;
  /** Allowed source states per actor role. */
  from: Partial<Record<Actor, S[]>>;
}

const OPEN_FOR_TRIAGE = [S.PENDING, S.ASSIGNED, S.REOPENED];

/**
 * The single source of truth for complaint status changes.
 * PENDING → ASSIGNED → WORK_IN_PROGRESS → RESOLVED → CLOSED, with REJECTED / DUPLICATE
 * exits during triage and RESOLVED → REOPENED when the citizen is not satisfied.
 */
export type TransitionAction = Exclude<ComplaintAction, ComplaintAction.CREATE | ComplaintAction.SLA_BREACH | ComplaintAction.ESCALATE>;

export const RULES: Record<TransitionAction, Rule> = {
  [ComplaintAction.ROUTE]: { to: S.ASSIGNED, from: { SYSTEM: [S.PENDING] } },
  [ComplaintAction.ASSIGN]: {
    to: S.ASSIGNED,
    from: { [Role.SUPERVISOR]: OPEN_FOR_TRIAGE, [Role.SUB_ADMIN]: OPEN_FOR_TRIAGE },
  },
  [ComplaintAction.START]: {
    to: S.WORK_IN_PROGRESS,
    from: {
      [Role.WORKER]: [S.ASSIGNED, S.REOPENED],
      [Role.SUPERVISOR]: [S.ASSIGNED, S.REOPENED],
      [Role.SUB_ADMIN]: [S.ASSIGNED, S.REOPENED],
    },
  },
  [ComplaintAction.RESOLVE]: {
    to: S.RESOLVED,
    from: {
      [Role.WORKER]: [S.WORK_IN_PROGRESS],
      [Role.SUPERVISOR]: [S.ASSIGNED, S.WORK_IN_PROGRESS, S.REOPENED],
      [Role.SUB_ADMIN]: [S.ASSIGNED, S.WORK_IN_PROGRESS, S.REOPENED],
    },
  },
  [ComplaintAction.REJECT]: {
    to: S.REJECTED,
    from: { [Role.SUPERVISOR]: OPEN_FOR_TRIAGE, [Role.SUB_ADMIN]: OPEN_FOR_TRIAGE },
  },
  [ComplaintAction.MARK_DUPLICATE]: {
    to: S.DUPLICATE,
    from: { [Role.SUPERVISOR]: OPEN_FOR_TRIAGE, [Role.SUB_ADMIN]: OPEN_FOR_TRIAGE },
  },
  [ComplaintAction.CLOSE]: { to: S.CLOSED, from: { [Role.CITIZEN]: [S.RESOLVED] } },
  [ComplaintAction.REOPEN]: { to: S.REOPENED, from: { [Role.CITIZEN]: [S.RESOLVED] } },
  [ComplaintAction.AUTO_CLOSE]: { to: S.CLOSED, from: { SYSTEM: [S.RESOLVED] } },
};

export class InvalidTransitionError extends Error {}

/** Returns the target status, or throws if this actor may not perform this action from this status. */
export function transition(action: TransitionAction, from: S, actor: Actor): S {
  const rule = RULES[action];
  if (!rule.from[actor]?.includes(from)) {
    throw new InvalidTransitionError(`${actor} cannot ${action} a complaint that is ${from}`);
  }
  return rule.to;
}

export const TERMINAL_STATUSES = [S.CLOSED, S.REJECTED, S.DUPLICATE];
