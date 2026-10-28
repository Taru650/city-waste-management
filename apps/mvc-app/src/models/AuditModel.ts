import type { Db } from '@/db/sql';
import { run } from '@/db/sql';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  ip?: string | null;
  meta?: unknown;
}

/** Append-only: this model has insert and read, never update or delete. */
export const AuditModel = {
  async log(d: Db, e: AuditEntry): Promise<void> {
    await run(d, `INSERT INTO audit_logs (actor_id, action, entity, entity_id, ip, meta) VALUES (?, ?, ?, ?, ?, ?)`, [
      e.actorId ?? null, e.action, e.entity ?? null, e.entityId ?? null, e.ip?.slice(0, 64) ?? null,
      e.meta === undefined ? null : JSON.stringify(e.meta),
    ]);
  },
};
