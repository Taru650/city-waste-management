import type { ComplaintStatus as S, Role } from './enums';

export type ComplaintAction =
  | 'CREATE' | 'ROUTE' | 'ASSIGN' | 'START' | 'RESOLVE' | 'REJECT' | 'MARK_DUPLICATE' | 'CLOSE' | 'REOPEN' | 'AUTO_CLOSE'
  // Timeline-only events (no status change), written by the SLA sweeper and the event-zone handover.
  | 'SLA_BREACH' | 'ESCALATE' | 'HANDOVER';

/** 'SYSTEM' = background jobs and automatic routing. */
export type Actor = Role | 'SYSTEM';

export type TransitionAction = Exclude<ComplaintAction, 'CREATE' | 'SLA_BREACH' | 'ESCALATE' | 'HANDOVER'>;

interface Rule {
  to: S;
  /** Allowed source states per actor role. */
  from: Partial<Record<Actor, S[]>>;
}

const OPEN_FOR_TRIAGE: S[] = ['PENDING', 'ASSIGNED', 'REOPENED'];

/**
 * The single source of truth for complaint status changes.
 * PENDING → ASSIGNED → WORK_IN_PROGRESS → RESOLVED → CLOSED, with REJECTED / DUPLICATE exits during triage
 * and RESOLVED → REOPENED when the citizen is not satisfied.
 */
export const RULES: Record<TransitionAction, Rule> = {
  ROUTE: { to: 'ASSIGNED', from: { SYSTEM: ['PENDING'] } },
  ASSIGN: { to: 'ASSIGNED', from: { SUPERVISOR: OPEN_FOR_TRIAGE, SUB_ADMIN: OPEN_FOR_TRIAGE } },
  START: { to: 'WORK_IN_PROGRESS', from: { WORKER: ['ASSIGNED', 'REOPENED'], SUPERVISOR: ['ASSIGNED', 'REOPENED'], SUB_ADMIN: ['ASSIGNED', 'REOPENED'] } },
  RESOLVE: {
    to: 'RESOLVED',
    from: {
      WORKER: ['WORK_IN_PROGRESS'],
      SUPERVISOR: ['ASSIGNED', 'WORK_IN_PROGRESS', 'REOPENED'],
      SUB_ADMIN: ['ASSIGNED', 'WORK_IN_PROGRESS', 'REOPENED'],
    },
  },
  REJECT: { to: 'REJECTED', from: { SUPERVISOR: OPEN_FOR_TRIAGE, SUB_ADMIN: OPEN_FOR_TRIAGE } },
  MARK_DUPLICATE: { to: 'DUPLICATE', from: { SUPERVISOR: OPEN_FOR_TRIAGE, SUB_ADMIN: OPEN_FOR_TRIAGE } },
  CLOSE: { to: 'CLOSED', from: { CITIZEN: ['RESOLVED'] } },
  REOPEN: { to: 'REOPENED', from: { CITIZEN: ['RESOLVED'] } },
  AUTO_CLOSE: { to: 'CLOSED', from: { SYSTEM: ['RESOLVED'] } },
};

export class InvalidTransitionError extends Error {}

/** Returns the target status, or throws if this actor may not perform this action from this status. */
export function transition(action: TransitionAction, from: S, actor: Actor): S {
  const rule = RULES[action];
  if (!rule.from[actor]?.includes(from)) throw new InvalidTransitionError(`${actor} cannot ${action} a complaint that is ${from}`);
  return rule.to;
}
