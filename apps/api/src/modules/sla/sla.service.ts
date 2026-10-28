import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { mutateReturning } from '../../common/db';
import { ComplaintsService } from '../complaints/complaints.service';
import { ComplaintAction } from '../complaints/state-machine';
import { JobsService, QUEUES } from '../jobs/jobs.service';
import { MediaService } from '../media/media.service';
import { NotificationsService } from '../notifications/notifications.service';
import { templates } from '../notifications/templates';
import { AttestationService } from '../attestation/attestation.service';
import { PrivacyService } from '../privacy/privacy.service';
import { ZonesService } from '../zones/zones.service';

const OPEN = `('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`;
const BATCH = 500;

interface SweptRow {
  id: string;
  complaint_no: string;
  status: string;
  supervisor_id: string | null;
  worker_id: string | null;
  ulb_id: string;
}

/**
 * SLA enforcement by periodic sweep rather than one timer per complaint: idempotent
 * (state lives in sla_breached_at / escalated_at), survives restarts and missed ticks,
 * and needs no rescheduling when a reopen moves the deadline.
 *   - past sla_due_at            → SLA_BREACH: supervisor and worker are told
 *   - past sla_due_at + SLA again (2× SLA) → ESCALATE: Sub Admins of the ULB are told
 */
@Injectable()
export class SlaService implements OnModuleInit {
  constructor(
    private readonly ds: DataSource,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly complaints: ComplaintsService,
    private readonly media: MediaService,
    private readonly attestation: AttestationService,
    private readonly zones: ZonesService,
    private readonly privacy: PrivacyService,
  ) {}

  onModuleInit() {
    this.jobs.process(QUEUES.MAINTENANCE, 'sla-sweep', () => this.sweep());
    this.jobs.process(QUEUES.MAINTENANCE, 'auto-close', () => this.complaints.autoCloseStale());
    this.jobs.process(QUEUES.MAINTENANCE, 'purge-media', () => this.media.purgeOrphans());
    this.jobs.every(QUEUES.MAINTENANCE, 'sla-sweep', 60_000);
    this.jobs.every(QUEUES.MAINTENANCE, 'auto-close', 3_600_000);
    this.jobs.every(QUEUES.MAINTENANCE, 'purge-media', 3_600_000);
    this.jobs.process(QUEUES.MAINTENANCE, 'purge-attestation', () => this.attestation.purgeExpired());
    this.jobs.every(QUEUES.MAINTENANCE, 'purge-attestation', 3_600_000);
    this.jobs.process(QUEUES.MAINTENANCE, 'zone-handover', () => this.zones.handover());
    this.jobs.every(QUEUES.MAINTENANCE, 'zone-handover', 300_000);
    this.jobs.process(QUEUES.MAINTENANCE, 'privacy-purge', () => this.privacy.purge());
    this.jobs.every(QUEUES.MAINTENANCE, 'privacy-purge', 86_400_000);
  }

  async sweep(): Promise<{ breached: number; escalated: number }> {
    let breached = 0;
    let escalated = 0;
    for (;;) {
      const n = await this.sweepBatch();
      breached += n.breached;
      escalated += n.escalated;
      if (n.breached < BATCH && n.escalated < BATCH) break;
    }
    if (breached || escalated) await this.notifications.kick();
    return { breached, escalated };
  }

  private sweepBatch() {
    return this.ds.transaction(async (m) => {
      const late = await mutateReturning<SweptRow>(
        m,
        `UPDATE complaints c SET sla_breached_at = now()
          WHERE c.id IN (SELECT id FROM complaints
                          WHERE status IN ${OPEN} AND sla_due_at < now() AND sla_breached_at IS NULL
                          ORDER BY sla_due_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
          RETURNING c.id, c.complaint_no, c.status, c.supervisor_id, c.worker_id, c.ulb_id`,
        [],
      );
      for (const c of late) {
        await this.timelineEvent(m, c, ComplaintAction.SLA_BREACH, 'Resolution deadline passed');
        const staff = c.supervisor_id || c.worker_id ? [c.supervisor_id, c.worker_id] : await this.notifications.subAdminsOf(m, c.ulb_id);
        await this.notifications.notify(m, staff, templates.slaBreached(c.complaint_no), c.id);
      }

      const escalations = await mutateReturning<SweptRow>(
        m,
        `UPDATE complaints c SET escalated = true, escalated_at = now()
          WHERE c.id IN (SELECT c2.id FROM complaints c2 JOIN complaint_types t ON t.id = c2.type_id
                          WHERE c2.status IN ${OPEN} AND c2.escalated_at IS NULL
                            AND c2.sla_due_at + make_interval(hours => t.sla_hours) < now()
                          ORDER BY c2.sla_due_at LIMIT ${BATCH} FOR UPDATE OF c2 SKIP LOCKED)
          RETURNING c.id, c.complaint_no, c.status, c.supervisor_id, c.worker_id, c.ulb_id`,
        [],
      );
      for (const c of escalations) {
        await this.timelineEvent(m, c, ComplaintAction.ESCALATE, 'Unresolved at twice the SLA');
        await this.notifications.notify(m, await this.notifications.subAdminsOf(m, c.ulb_id), templates.escalated(c.complaint_no), c.id);
      }
      return { breached: late.length, escalated: escalations.length };
    });
  }

  private timelineEvent(m: import('typeorm').EntityManager, c: SweptRow, action: ComplaintAction, remark: string) {
    return m.query(
      `INSERT INTO complaint_events (complaint_id, action, from_status, to_status, actor_id, remark) VALUES ($1, $2, $3, $3, NULL, $4)`,
      [c.id, action, c.status, remark],
    );
  }
}
