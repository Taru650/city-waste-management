import type { Db } from '@/db/sql';
import { query, run } from '@/db/sql';

export interface SweptRow {
  id: string;
  complaint_no: string;
  status: string;
  supervisor_id: string | null;
  worker_id: string | null;
  ulb_id: string;
}

const OPEN = `('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`;
const COLUMNS = 'c.id, c.complaint_no, c.status, c.supervisor_id, c.worker_id, c.ulb_id';

/**
 * Two steps per batch: look up the candidates without locking anything, then lock just those rows (skipping rows
 * another sweeper or a person is working on) and re-check the condition. Locking while scanning would lock every
 * open complaint the scan passes.
 */
export const SlaModel = {
  /** Open complaints past their deadline that nobody has been told about yet. */
  async markBreached(d: Db, batch: number): Promise<SweptRow[]> {
    const ids = (await query<{ id: string }>(
      d,
      `SELECT c.id FROM complaints c WHERE c.status IN ${OPEN} AND c.sla_due_at < NOW(3) AND c.sla_breached_at IS NULL ORDER BY c.sla_due_at LIMIT ?`,
      [batch],
    )).map((r) => r.id);
    if (!ids.length) return [];
    const rows = await query<SweptRow>(
      d,
      `SELECT ${COLUMNS} FROM complaints c WHERE c.id IN (?) AND c.status IN ${OPEN} AND c.sla_due_at < NOW(3) AND c.sla_breached_at IS NULL FOR UPDATE SKIP LOCKED`,
      [ids],
    );
    if (rows.length) await run(d, `UPDATE complaints SET sla_breached_at = NOW(3) WHERE id IN (?)`, [rows.map((r) => r.id)]);
    return rows;
  },

  /** Open complaints still unresolved a whole SLA after their deadline (twice the SLA). */
  async markEscalated(d: Db, batch: number): Promise<SweptRow[]> {
    const ids = (await query<{ id: string }>(
      d,
      `SELECT c.id FROM complaints c JOIN complaint_types t ON t.id = c.type_id
        WHERE c.status IN ${OPEN} AND c.escalated_at IS NULL AND DATE_ADD(c.sla_due_at, INTERVAL t.sla_hours HOUR) < NOW(3)
        ORDER BY c.sla_due_at LIMIT ?`,
      [batch],
    )).map((r) => r.id);
    if (!ids.length) return [];
    const rows = await query<SweptRow>(
      d,
      `SELECT ${COLUMNS} FROM complaints c JOIN complaint_types t ON t.id = c.type_id
        WHERE c.id IN (?) AND c.status IN ${OPEN} AND c.escalated_at IS NULL AND DATE_ADD(c.sla_due_at, INTERVAL t.sla_hours HOUR) < NOW(3)
          FOR UPDATE OF c SKIP LOCKED`,
      [ids],
    );
    if (rows.length) await run(d, `UPDATE complaints SET escalated = 1, escalated_at = NOW(3) WHERE id IN (?)`, [rows.map((r) => r.id)]);
    return rows;
  },
};
