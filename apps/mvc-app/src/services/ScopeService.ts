import type { Db } from '@/db/sql';
import { forbidden, notFound } from '@/lib/errors';
import { UlbModel } from '@/models/MasterModel';
import type { AuthUser } from '@/middleware/auth';

/** Can this admin manage masters and staff of the given ULB? Web Admin: any; District Admin: own district; Sub Admin: own ULB. */
export async function assertCanManageUlb(d: Db, user: AuthUser, ulbId: string) {
  const ulb = await UlbModel.find(d, ulbId);
  if (!ulb) throw notFound('ULB not found');
  const ok =
    user.role === 'WEB_ADMIN' ||
    (user.role === 'DISTRICT_ADMIN' && ulb.district_id === user.districtId) ||
    (user.role === 'SUB_ADMIN' && ulb.id === user.ulbId);
  if (!ok) throw forbidden('Outside your jurisdiction');
  return ulb;
}
