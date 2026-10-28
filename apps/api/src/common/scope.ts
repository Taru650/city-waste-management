import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from './auth-user';
import { Role } from './enums';

/** Can this admin manage masters/staff of the given ULB? */
export async function assertCanManageUlb(db: DataSource | EntityManager, user: AuthUser, ulbId: string) {
  const [ulb] = await db.query(`SELECT id, district_id FROM ulbs WHERE id = $1`, [ulbId]);
  if (!ulb) throw new NotFoundException('ULB not found');
  const ok =
    user.role === Role.WEB_ADMIN ||
    (user.role === Role.DISTRICT_ADMIN && ulb.district_id === user.districtId) ||
    (user.role === Role.SUB_ADMIN && ulb.id === user.ulbId);
  if (!ok) throw new ForbiddenException('Outside your jurisdiction');
  return ulb as { id: string; district_id: string };
}
