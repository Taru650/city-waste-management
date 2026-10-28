import type { Db } from '@/db/sql';
import { one, query, run } from '@/db/sql';
import type { GeoJsonPolygon } from '@/lib/geo';
import type { AuthUser } from '@/middleware/auth';
import type { Fragment } from './ComplaintModel';

const GEOM = `ST_GeomFromGeoJSON(?, 1, 4326)`;
const OPEN = `('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`;

const COLUMNS = `z.id, z.ulb_id AS ulbId, u.name AS ulbName, z.name, ST_AsGeoJSON(z.geom, 6) AS boundary,
  z.starts_at AS startsAt, z.ends_at AS endsAt, z.supervisor_id AS supervisorId, s.name AS supervisorName,
  z.sla_hours AS slaHours, z.active, z.handed_over_at AS handedOverAt,
  (z.active AND NOW(3) BETWEEN z.starts_at AND z.ends_at) AS isCurrent,
  ROUND(ST_Area(z.geom)) AS areaM2`;
const FROM = `FROM event_zones z JOIN ulbs u ON u.id = z.ulb_id LEFT JOIN users s ON s.id = z.supervisor_id`;

/** Which zones a user may see: admins by jurisdiction, supervisors the zones they run. */
export function zoneScope(user: AuthUser): Fragment {
  switch (user.role) {
    case 'WEB_ADMIN':
      return { sql: 'TRUE', params: [] };
    case 'DISTRICT_ADMIN':
      return { sql: 'u.district_id = ?', params: [user.districtId] };
    case 'SUB_ADMIN':
      return { sql: 'z.ulb_id = ?', params: [user.ulbId] };
    case 'SUPERVISOR':
      return { sql: 'z.supervisor_id = ?', params: [user.id] };
    default:
      return { sql: 'FALSE', params: [] };
  }
}

export interface ZoneValues {
  name: string;
  boundary: GeoJsonPolygon;
  startsAt: Date;
  endsAt: Date;
  supervisorId: string | null;
  slaHours: number | null;
}

type Row = Record<string, any>;  
const shape = (r: Row) => ({
  ...r,
  boundary: typeof r.boundary === 'string' ? JSON.parse(r.boundary) : r.boundary,
  active: !!r.active,
  current: !!r.isCurrent,
  isCurrent: undefined,
  areaM2: Number(r.areaM2),
});

export const ZoneModel = {
  async list(d: Db, scope: Fragment, f: { ulbId?: string; when: 'current' | 'upcoming' | 'past' | 'all' }) {
    const where = [scope.sql];
    const params: unknown[] = [...scope.params];
    if (f.ulbId) {
      where.push('z.ulb_id = ?');
      params.push(f.ulbId);
    }
    if (f.when === 'current') where.push('(z.active AND NOW(3) BETWEEN z.starts_at AND z.ends_at)');
    if (f.when === 'upcoming') where.push('(z.active AND z.starts_at > NOW(3))');
    if (f.when === 'past') where.push('(z.ends_at < NOW(3) OR NOT z.active)');
    return (await query(d, `SELECT ${COLUMNS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY z.starts_at DESC, z.id LIMIT 200`, params)).map(shape);
  },

  async findVisible(d: Db, id: string, scope: Fragment) {
    const r = await one(d, `SELECT ${COLUMNS} ${FROM} WHERE z.id = ? AND ${scope.sql}`, [id, ...scope.params]);
    return r && shape(r);
  },

  async stats(d: Db, id: string) {
    const r = await one(
      d,
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status IN ${OPEN}), 0) AS open,
              COALESCE(SUM(status IN ${OPEN} AND sla_due_at < NOW(3)), 0) AS overdue,
              ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND, created_at, resolved_at) / 3600000000 END), 1) AS avgDisposalHours
         FROM complaints WHERE event_zone_id = ?`,
      [id],
    );
    return { total: Number(r!.total), open: Number(r!.open), overdue: Number(r!.overdue), avgDisposalHours: r!.avgDisposalHours === null ? null : Number(r!.avgDisposalHours) };
  },

  /** Locks and returns the zone for an update. */
  lock(d: Db, id: string) {
    return one<{ id: string; ulb_id: string; name: string; boundary: unknown; starts_at: Date; ends_at: Date; supervisor_id: string | null; sla_hours: number | null; active: boolean }>(
      d,
      `SELECT id, ulb_id, name, ST_AsGeoJSON(geom) AS boundary, starts_at, ends_at, supervisor_id, sla_hours, active FROM event_zones WHERE id = ? FOR UPDATE`,
      [id],
    );
  },

  async insert(d: Db, v: ZoneValues & { id: string; ulbId: string; createdBy: string }) {
    await run(
      d,
      `INSERT INTO event_zones (id, ulb_id, name, geom, starts_at, ends_at, supervisor_id, sla_hours, created_by) VALUES (?,?,?, ${GEOM}, ?,?,?,?,?)`,
      [v.id, v.ulbId, v.name, JSON.stringify(v.boundary), v.startsAt, v.endsAt, v.supervisorId, v.slaHours, v.createdBy],
    );
  },

  async update(d: Db, id: string, v: ZoneValues & { active: boolean }) {
    await run(
      d,
      `UPDATE event_zones SET name = ?, geom = ${GEOM}, starts_at = ?, ends_at = ?, supervisor_id = ?, sla_hours = ?, active = ?,
              -- re-opened or extended into the future: it will need a handover again when it ends
              handed_over_at = IF(? AND ? > NOW(3), NULL, handed_over_at)
        WHERE id = ?`,
      [v.name, JSON.stringify(v.boundary), v.startsAt, v.endsAt, v.supervisorId, v.slaHours, v.active ? 1 : 0, v.active ? 1 : 0, v.endsAt, id],
    );
  },

  /** Geometry checks MySQL has to make: valid, its size in m², and whether it touches any ward of the ULB. */
  checkGeometry(d: Db, ulbId: string, boundary: GeoJsonPolygon) {
    return one<{ valid: number; area: number; in_ulb: number }>(
      d,
      `SELECT ST_IsValid(g.g) AS valid, ST_Area(g.g) AS area,
              EXISTS (SELECT 1 FROM ward_boundaries b JOIN wards w ON w.id = b.ward_id WHERE w.ulb_id = ? AND ST_Intersects(b.geom, g.g)) AS in_ulb
         FROM (SELECT ${GEOM} AS g) g`,
      [ulbId, JSON.stringify(boundary)],
    );
  },

  /** Another active zone of the ULB over the same place during the same time. */
  async clash(d: Db, ulbId: string, selfId: string | null, startsAt: Date, endsAt: Date, boundary: GeoJsonPolygon) {
    return (await one<{ name: string }>(
      d,
      `SELECT name FROM event_zones
        WHERE active AND ulb_id = ? AND (? IS NULL OR id <> ?) AND starts_at < ? AND ends_at > ? AND ST_Intersects(geom, ${GEOM}) LIMIT 1`,
      [ulbId, selfId, selfId, endsAt, startsAt, JSON.stringify(boundary)],
    ))?.name;
  },

  supervisorOk(d: Db, supervisorId: string, ulbId: string) {
    return one<{ access_expires_at: Date | null }>(d, `SELECT access_expires_at FROM users WHERE id = ? AND role = 'SUPERVISOR' AND ulb_id = ? AND status = 'ACTIVE'`, [supervisorId, ulbId]);
  },

  /** Ended or cancelled zones that still need their open complaints handed back. */
  dueForHandover(d: Db) {
    return query<{ id: string; name: string; supervisor_id: string | null; ulb_id: string }>(
      d,
      `SELECT id, name, supervisor_id, ulb_id FROM event_zones WHERE handed_over_at IS NULL AND (ends_at < NOW(3) OR NOT active) LIMIT 50`,
    );
  },
  async lockForHandover(d: Db, id: string): Promise<boolean> {
    return !!(await one(d, `SELECT 1 AS x FROM event_zones WHERE id = ? AND handed_over_at IS NULL FOR UPDATE SKIP LOCKED`, [id]));
  },
  /** Open complaints still with the zone's supervisor, and who runs their area now. */
  complaintsToHandBack(d: Db, zoneId: string, zoneSupervisor: string | null) {
    return query<{ id: string; complaint_no: string; status: string; new_supervisor: string | null }>(
      d,
      `SELECT c.id, c.complaint_no, c.status,
              (SELECT a.supervisor_id FROM areas a JOIN users s ON s.id = a.supervisor_id AND s.status = 'ACTIVE' WHERE a.id = c.area_id) AS new_supervisor
         FROM complaints c WHERE c.event_zone_id = ? AND c.status IN ${OPEN} AND c.supervisor_id <=> ? FOR UPDATE`,
      [zoneId, zoneSupervisor],
    );
  },
  async setComplaintSupervisor(d: Db, complaintId: string, supervisorId: string | null) {
    await run(d, `UPDATE complaints SET supervisor_id = ? WHERE id = ?`, [supervisorId, complaintId]);
  },
  async markHandedOver(d: Db, id: string) {
    await run(d, `UPDATE event_zones SET handed_over_at = NOW(3) WHERE id = ?`, [id]);
  },
};
