import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

@Injectable()
export class AuditService {
  constructor(private readonly ds: DataSource) {}

  async log(
    entry: { actorId: string | null; action: string; entity?: string; entityId?: string; ip?: string; meta?: object },
    manager: EntityManager = this.ds.manager,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO audit_logs (actor_id, action, entity, entity_id, ip, meta) VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.actorId, entry.action, entry.entity ?? null, entry.entityId ?? null, entry.ip ?? null, entry.meta ?? null],
    );
  }
}
