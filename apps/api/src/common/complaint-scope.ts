import { AuthUser } from './auth-user';
import { Role } from './enums';

/**
 * The single definition of which complaints a caller may see (alias `c`). Used by the
 * complaint API and by every report, so a report can never show more than the inbox.
 */
export function complaintScope(user: AuthUser, params: unknown[]): string {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  switch (user.role) {
    case Role.WEB_ADMIN:
      return 'TRUE';
    case Role.DISTRICT_ADMIN:
      return `c.district_id = ${p(user.districtId)}`;
    case Role.SUB_ADMIN:
      return `c.ulb_id = ${p(user.ulbId)}`;
    case Role.SUPERVISOR: {
      const me = p(user.id);
      return `(c.supervisor_id = ${me} OR c.area_id IN (SELECT id FROM areas WHERE supervisor_id = ${me}))`;
    }
    case Role.WORKER:
      return `c.worker_id = ${p(user.id)}`;
    case Role.CITIZEN:
      return `c.citizen_id = ${p(user.id)}`;
    default:
      return 'FALSE';
  }
}

