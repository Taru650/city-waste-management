import { db } from '@/db/connection';
import type { Db } from '@/db/sql';
import { templates } from '@/lib/notificationTemplates';
import { ComplaintModel } from '@/models/ComplaintModel';
import { SlaModel, type SweptRow } from '@/models/SlaModel';
import { NotificationService } from './NotificationService';

const BATCH = 500;

/**
 * SLA enforcement by periodic sweep rather than one timer per complaint: idempotent (state lives in sla_breached_at /
 * escalated_at), survives restarts and missed ticks, and needs no rescheduling when a reopen moves the deadline.
 *   - past sla_due_at                       SLA_BREACH: the supervisor and worker are told
 *   - past sla_due_at plus the SLA again    ESCALATE: the Sub Admins of the ULB are told
 */
export const SlaService = {
  async sweep(batch = BATCH): Promise<{ breached: number; escalated: number }> {
    let breached = 0;
    let escalated = 0;
    for (;;) {
      const n = await db().transaction(async (trx) => {
        const late = await SlaModel.markBreached(trx, batch);
        for (const c of late) {
          await timelineEvent(trx, c, 'SLA_BREACH', 'Resolution deadline passed');
          const staff = c.supervisor_id || c.worker_id ? [c.supervisor_id, c.worker_id] : await NotificationService.subAdminsOf(trx, c.ulb_id);
          await NotificationService.notify(trx, staff, templates.slaBreached(c.complaint_no), c.id);
        }
        const escalations = await SlaModel.markEscalated(trx, batch);
        for (const c of escalations) {
          await timelineEvent(trx, c, 'ESCALATE', 'Unresolved at twice the SLA');
          await NotificationService.notify(trx, await NotificationService.subAdminsOf(trx, c.ulb_id), templates.escalated(c.complaint_no), c.id);
        }
        return { breached: late.length, escalated: escalations.length };
      });
      breached += n.breached;
      escalated += n.escalated;
      if (n.breached < batch && n.escalated < batch) break;
    }
    if (breached || escalated) await NotificationService.kick();
    return { breached, escalated };
  },
};

function timelineEvent(d: Db, c: SweptRow, action: 'SLA_BREACH' | 'ESCALATE', remark: string) {
  return ComplaintModel.insertEvent(d, { complaintId: c.id, action, from: c.status, to: c.status, actorId: null, remark });
}
