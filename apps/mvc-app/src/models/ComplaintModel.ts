import type { Db } from '@/db/sql';
import { POINT_SQL, one, pointParams, query, run } from '@/db/sql';
import type { ComplaintStatus } from '@/lib/enums';
import type { AuthUser } from '@/middleware/auth';

/** A SQL fragment plus the values for its `?` placeholders. */
export interface Fragment {
  sql: string;
  params: unknown[];
}

/**
 * The single definition of which complaints a caller may see (alias `c`). Used by the complaint API and by every
 * report, so a report can never show more than the inbox does.
 */
export function complaintScope(user: AuthUser): Fragment {
  switch (user.role) {
    case 'WEB_ADMIN':
      return { sql: 'TRUE', params: [] };
    case 'DISTRICT_ADMIN':
      return { sql: 'c.district_id = ?', params: [user.districtId] };
    case 'SUB_ADMIN':
      return { sql: 'c.ulb_id = ?', params: [user.ulbId] };
    case 'SUPERVISOR':
      return { sql: '(c.supervisor_id = ? OR c.area_id IN (SELECT a.id FROM areas a WHERE a.supervisor_id = ?))', params: [user.id, user.id] };
    case 'WORKER':
      return { sql: 'c.worker_id = ?', params: [user.id] };
    case 'CITIZEN':
      return { sql: 'c.citizen_id = ?', params: [user.id] };
    default:
      return { sql: 'FALSE', params: [] };
  }
}

export interface ComplaintRow {
  id: string;
  status: ComplaintStatus;
  citizen_id: string;
  district_id: string;
  ulb_id: string;
  area_id: string | null;
  supervisor_id: string | null;
  worker_id: string | null;
  type_id: string;
  reopen_count: number;
  created_at: Date;
  resolved_within_window: boolean;
}

export const VIEW_COLUMNS = `
  c.id, c.complaint_no, c.status, c.description, c.landmark, c.ward_source, c.ward_mismatch,
  c.lat, c.lng, c.gps_accuracy_m,
  c.district_id, d.name AS district_name, c.ulb_id, u.name AS ulb_name, u.type AS ulb_type,
  c.ward_id, w.number AS ward_number, c.area_id,
  c.type_id, t.code AS type_code, t.name_en AS type_name_en, t.name_hi AS type_name_hi,
  c.supervisor_id, sv.name AS supervisor_name, c.worker_id, wk.name AS worker_name,
  c.event_zone_id, ez.name AS event_zone_name,
  c.duplicate_of, c.reopen_count, c.escalated, c.resolution_remark,
  c.sla_due_at, c.sla_breached_at, c.escalated_at, c.assigned_at, c.resolved_at, c.closed_at, c.created_at, c.updated_at,
  (c.sla_due_at < COALESCE(c.resolved_at, NOW(3))) AS sla_breached`;

export const VIEW_JOINS = `
  FROM complaints c
  JOIN districts d ON d.id = c.district_id
  JOIN ulbs u ON u.id = c.ulb_id
  JOIN wards w ON w.id = c.ward_id
  JOIN complaint_types t ON t.id = c.type_id
  LEFT JOIN users sv ON sv.id = c.supervisor_id
  LEFT JOIN users wk ON wk.id = c.worker_id
  LEFT JOIN event_zones ez ON ez.id = c.event_zone_id`;

export interface ListFilters {
  status?: string;
  ulbId?: string;
  wardId?: string;
  typeId?: string;
  eventZoneId?: string;
  from?: Date;
  to?: Date;
  escalated?: boolean;
  open?: boolean;
  overdue?: boolean;
}

const OPEN_SQL = `c.status IN ('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`;

export interface NewComplaint {
  id: string;
  complaintNo: string;
  citizenId: string;
  districtId: string;
  ulbId: string;
  wardId: string;
  areaId: string | null;
  wardSource: 'GPS' | 'MANUAL';
  wardMismatch: boolean;
  typeId: string;
  landmark: string | null;
  description: string;
  lat: number;
  lng: number;
  gpsAccuracyM: number | null;
  slaHours: number;
  eventZoneId: string | null;
}

export const ComplaintModel = {
  async list(d: Db, scope: Fragment, f: ListFilters, limit: number, offset: number) {
    const where = [scope.sql];
    const params: unknown[] = [...scope.params];
    const add = (sql: string, v: unknown) => {
      where.push(sql);
      params.push(v);
    };
    if (f.status) add('c.status = ?', f.status);
    if (f.ulbId) add('c.ulb_id = ?', f.ulbId);
    if (f.wardId) add('c.ward_id = ?', f.wardId);
    if (f.typeId) add('c.type_id = ?', f.typeId);
    if (f.eventZoneId) add('c.event_zone_id = ?', f.eventZoneId);
    if (f.from) add('c.created_at >= ?', f.from);
    if (f.to) add('c.created_at < ?', f.to);
    if (f.escalated !== undefined) add('c.escalated = ?', f.escalated ? 1 : 0);
    if (f.open) where.push(OPEN_SQL);
    if (f.overdue) where.push(`${OPEN_SQL} AND c.sla_due_at < NOW(3)`);
    const whereSql = where.join(' AND ');
    const total = await one<{ n: number }>(d, `SELECT COUNT(*) AS n FROM complaints c WHERE ${whereSql}`, params);
    const rows = await query(d, `SELECT ${VIEW_COLUMNS} ${VIEW_JOINS} WHERE ${whereSql} ORDER BY c.created_at DESC, c.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { total: Number(total?.n ?? 0), rows };
  },

  findView(d: Db, id: string, scope?: Fragment) {
    return one(d, `SELECT ${VIEW_COLUMNS} ${VIEW_JOINS} WHERE c.id = ?${scope ? ` AND ${scope.sql}` : ''}`, [id, ...(scope?.params ?? [])]);
  },

  async idByNumber(d: Db, complaintNo: string, scope: Fragment): Promise<string | undefined> {
    return (await one<{ id: string }>(d, `SELECT c.id FROM complaints c WHERE c.complaint_no = ? AND ${scope.sql}`, [complaintNo, ...scope.params]))?.id;
  },

  async visible(d: Db, id: string, scope: Fragment): Promise<boolean> {
    return !!(await one(d, `SELECT 1 AS x FROM complaints c WHERE c.id = ? AND ${scope.sql}`, [id, ...scope.params]));
  },

  events(d: Db, complaintId: string) {
    return query(
      d,
      `SELECT e.action, e.from_status AS fromStatus, e.to_status AS toStatus, e.remark, e.created_at AS \`at\`,
              a.role AS actorRole, IF(a.role = 'CITIZEN', NULL, a.name) AS actorName
         FROM complaint_events e LEFT JOIN users a ON a.id = e.actor_id
        WHERE e.complaint_id = ? ORDER BY e.id`,
      [complaintId],
    );
  },

  feedbackOf(d: Db, complaintId: string) {
    return query(d, `SELECT rating, remark, reopen_requested AS reopenRequested, created_at AS createdAt FROM feedback WHERE complaint_id = ? ORDER BY created_at, id`, [complaintId]);
  },

  async recentCountByCitizen(d: Db, citizenId: string): Promise<number> {
    const r = await one<{ n: number }>(d, `SELECT COUNT(*) AS n FROM complaints WHERE citizen_id = ? AND created_at > DATE_SUB(NOW(3), INTERVAL 24 HOUR)`, [citizenId]);
    return Number(r?.n ?? 0);
  },

  /** Next per-ULB, per-year sequence number. The row lock is held until the caller's transaction ends, so numbers never repeat. */
  async nextSequence(d: Db, ulbId: string): Promise<{ year: number; seq: number }> {
    const y = await one<{ y: number }>(d, `SELECT YEAR(CONVERT_TZ(NOW(), '+00:00', '+05:30')) AS y`);
    const year = Number(y!.y);
    await run(d, `INSERT INTO complaint_seq (ulb_id, year, last_no) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE last_no = last_no + 1`, [ulbId, year]);
    const r = await one<{ last_no: number }>(d, `SELECT last_no FROM complaint_seq WHERE ulb_id = ? AND year = ? FOR UPDATE`, [ulbId, year]);
    return { year, seq: Number(r!.last_no) };
  },

  async insert(d: Db, v: NewComplaint): Promise<void> {
    await run(
      d,
      `INSERT INTO complaints (id, complaint_no, citizen_id, district_id, ulb_id, ward_id, area_id, ward_source, ward_mismatch, type_id,
                               landmark, description, location, gps_accuracy_m, status, sla_due_at, event_zone_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ${POINT_SQL}, ?, 'PENDING', DATE_ADD(NOW(3), INTERVAL ? HOUR), ?)`,
      [
        v.id, v.complaintNo, v.citizenId, v.districtId, v.ulbId, v.wardId, v.areaId, v.wardSource, v.wardMismatch ? 1 : 0, v.typeId,
        v.landmark, v.description, ...pointParams(v.lng, v.lat), v.gpsAccuracyM, v.slaHours, v.eventZoneId,
      ],
    );
  },

  async insertEvent(d: Db, e: { complaintId: string; action: string; from: string | null; to: string; actorId: string | null; remark: string | null; meta?: unknown }) {
    await run(d, `INSERT INTO complaint_events (complaint_id, action, from_status, to_status, actor_id, remark, meta) VALUES (?,?,?,?,?,?,?)`, [
      e.complaintId, e.action, e.from, e.to, e.actorId, e.remark?.slice(0, 500) ?? null, e.meta === undefined ? null : JSON.stringify(e.meta),
    ]);
  },

  /** Locks the complaint for one status change, if the caller may see it. */
  async lockForAction(d: Db, id: string, scope: Fragment, windowDays: number): Promise<ComplaintRow | undefined> {
    const r = await one<Omit<ComplaintRow, 'resolved_within_window'> & { resolved_within_window: number }>(
      d,
      `SELECT c.id, c.status, c.citizen_id, c.district_id, c.ulb_id, c.area_id, c.supervisor_id, c.worker_id, c.type_id, c.reopen_count, c.created_at,
              (c.resolved_at IS NOT NULL AND c.resolved_at > DATE_SUB(NOW(3), INTERVAL ? DAY)) AS resolved_within_window
         FROM complaints c WHERE c.id = ? AND ${scope.sql}
         FOR UPDATE`,
      [windowDays, id, ...scope.params],
    );
    return r && { ...r, resolved_within_window: !!r.resolved_within_window };
  },

  async summary(d: Db, id: string) {
    return one<{ complaint_no: string; citizen_id: string; supervisor_id: string | null; worker_id: string | null; ulb_id: string; escalated: boolean }>(
      d,
      `SELECT complaint_no, citizen_id, supervisor_id, worker_id, ulb_id, escalated FROM complaints WHERE id = ?`,
      [id],
    );
  },

  async setRouted(d: Db, id: string, supervisorId: string) {
    await run(d, `UPDATE complaints SET status = 'ASSIGNED', supervisor_id = ?, assigned_at = NOW(3) WHERE id = ?`, [supervisorId, id]);
  },
  async setAssigned(d: Db, id: string, v: { workerId: string | null; supervisorId: string | null }) {
    await run(d, `UPDATE complaints SET status = 'ASSIGNED', worker_id = ?, supervisor_id = ?, assigned_at = COALESCE(assigned_at, NOW(3)) WHERE id = ?`, [v.workerId, v.supervisorId, id]);
  },
  async setStarted(d: Db, id: string) {
    await run(d, `UPDATE complaints SET status = 'WORK_IN_PROGRESS' WHERE id = ?`, [id]);
  },
  async setResolved(d: Db, id: string, remark: string) {
    await run(d, `UPDATE complaints SET status = 'RESOLVED', resolved_at = NOW(3), resolution_remark = ? WHERE id = ?`, [remark, id]);
  },
  async setRejected(d: Db, id: string) {
    await run(d, `UPDATE complaints SET status = 'REJECTED', closed_at = NOW(3) WHERE id = ?`, [id]);
  },
  async setDuplicate(d: Db, id: string, originalId: string) {
    await run(d, `UPDATE complaints SET status = 'DUPLICATE', duplicate_of = ?, closed_at = NOW(3) WHERE id = ?`, [originalId, id]);
  },
  async setClosed(d: Db, id: string) {
    await run(d, `UPDATE complaints SET status = 'CLOSED', closed_at = NOW(3) WHERE id = ?`, [id]);
  },
  async setReopened(d: Db, id: string, escalate: boolean, typeId: string) {
    await run(
      d,
      `UPDATE complaints SET status = 'REOPENED', reopen_count = reopen_count + 1, escalated = (escalated OR ?),
              resolved_at = NULL, sla_breached_at = NULL, escalated_at = NULL,
              sla_due_at = DATE_ADD(NOW(3), INTERVAL (SELECT sla_hours FROM complaint_types WHERE id = ?) HOUR)
        WHERE id = ?`,
      [escalate ? 1 : 0, typeId, id],
    );
  },

  async insertFeedback(d: Db, v: { complaintId: string; citizenId: string; rating: number; remark: string | null; reopen: boolean }) {
    await run(d, `INSERT INTO feedback (complaint_id, citizen_id, rating, remark, reopen_requested) VALUES (?,?,?,?,?)`, [v.complaintId, v.citizenId, v.rating, v.remark, v.reopen ? 1 : 0]);
  },

  /** An open or resolved complaint of the same ULB that this one can be merged into. */
  originalFor(d: Db, originalId: string, ulbId: string) {
    return one<{ id: string }>(d, `SELECT id FROM complaints WHERE id = ? AND ulb_id = ? AND status NOT IN ('DUPLICATE','REJECTED')`, [originalId, ulbId]);
  },

  staffOfUlb(d: Db, userId: string, role: string, ulbId: string) {
    return one<{ id: string }>(
      d,
      `SELECT id FROM users WHERE id = ? AND role = ? AND ulb_id = ? AND status = 'ACTIVE' AND (access_expires_at IS NULL OR access_expires_at > NOW(3))`,
      [userId, role, ulbId],
    );
  },

  /** How far (metres) a point is from the complaint. */
  async distanceTo(d: Db, id: string, lng: number, lat: number): Promise<number> {
    const r = await one<{ m: number }>(d, `SELECT ST_Distance(location, ${POINT_SQL}) AS m FROM complaints WHERE id = ?`, [...pointParams(lng, lat), id]);
    return Number(r?.m ?? 0);
  },

  /**
   * Possible duplicates: same type and ULB, within `radiusM`, filed within `windowHours` of this one. The latitude and
   * longitude window narrows the search through the (ulb, type, lat) index before the exact geodesic distance is computed.
   */
  duplicateCandidates(d: Db, id: string, scope: Fragment, radiusM: number, windowHours: number) {
    return query(
      d,
      `SELECT ${VIEW_COLUMNS}, ST_Distance(c.location, base.location) AS distance_m
         ${VIEW_JOINS}
         JOIN complaints base ON base.id = ?
        WHERE c.id <> base.id AND c.type_id = base.type_id AND c.ulb_id = base.ulb_id
          AND c.status NOT IN ('DUPLICATE','REJECTED')
          AND c.lat BETWEEN base.lat - (? / 100000.0) AND base.lat + (? / 100000.0)
          AND c.lng BETWEEN base.lng - (? / (100000.0 * GREATEST(COS(RADIANS(base.lat)), 0.05))) AND base.lng + (? / (100000.0 * GREATEST(COS(RADIANS(base.lat)), 0.05)))
          AND ST_Distance(c.location, base.location) <= ?
          AND c.created_at BETWEEN DATE_SUB(base.created_at, INTERVAL ? HOUR) AND DATE_ADD(base.created_at, INTERVAL ? HOUR)
          AND ${scope.sql}
        ORDER BY distance_m, c.id LIMIT 20`,
      [id, radiusM * 1.2, radiusM * 1.2, radiusM * 1.2, radiusM * 1.2, radiusM, windowHours, windowHours, ...scope.params],
    );
  },

  /** Resolved complaints nobody rated within the window (locked for the caller's transaction). */
  staleResolved(d: Db, days: number) {
    return query<{ id: string; complaint_no: string; citizen_id: string }>(
      d,
      `SELECT id, complaint_no, citizen_id FROM complaints WHERE status = 'RESOLVED' AND resolved_at < DATE_SUB(NOW(3), INTERVAL ? DAY) LIMIT 500 FOR UPDATE SKIP LOCKED`,
      [days],
    );
  },
};
