import {
  BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../../common/auth-user';
import { mutateReturning } from '../../common/db';
import { ComplaintStatus, Role, WardSource } from '../../common/enums';
import { MediaService, MediaStage } from '../media/media.service';
import { NotificationsService } from '../notifications/notifications.service';
import { templates } from '../notifications/templates';
import { complaintScope as scopeFilter } from '../../common/complaint-scope';
import { buildComplaintNo, formatComplaintNo, normalizeComplaintNo, SEQ_MAX } from './complaint-number';
import {
  AssignDto, CreateComplaintDto, DuplicateDto, FeedbackDto, GeoPointDto, ListComplaintsQuery, RejectDto, ResolveDto, StartWorkDto,
} from './dto/complaints.dto';
import { Actor, ComplaintAction, InvalidTransitionError, transition, TransitionAction } from './state-machine';
import { ZonesService } from '../zones/zones.service';

export const MAX_COMPLAINTS_PER_DAY = 10;
/** A manually chosen ward further than this from the GPS point is flagged for the supervisor. */
export const WARD_MISMATCH_METERS = 500;
/** Resolution recorded further than this from the complaint is flagged in quality reports. */
export const RESOLUTION_GEOFENCE_METERS = 100;
export const FEEDBACK_WINDOW_DAYS = 7;
export const MAX_REOPENS = 2;
export const DUPLICATE_RADIUS_METERS = 50;
export const DUPLICATE_WINDOW_HOURS = 48;

interface ComplaintRow {
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

const VIEW_COLUMNS = `
  c.id, c.complaint_no, c.status, c.description, c.landmark, c.ward_source, c.ward_mismatch,
  ST_Y(c.location) AS lat, ST_X(c.location) AS lng, c.gps_accuracy_m,
  c.district_id, d.name AS district_name, c.ulb_id, u.name AS ulb_name, u.type AS ulb_type,
  c.ward_id, w.number AS ward_number, c.area_id,
  c.type_id, t.code AS type_code, t.name_en AS type_name_en, t.name_hi AS type_name_hi,
  c.supervisor_id, sv.name AS supervisor_name, c.worker_id, wk.name AS worker_name,
  c.event_zone_id, ez.name AS event_zone_name,
  c.duplicate_of, c.reopen_count, c.escalated, c.resolution_remark,
  c.sla_due_at, c.sla_breached_at, c.escalated_at, c.assigned_at, c.resolved_at, c.closed_at, c.created_at, c.updated_at,
  (c.sla_due_at < COALESCE(c.resolved_at, now())) AS sla_breached`;

const VIEW_JOINS = `
  FROM complaints c
  JOIN districts d ON d.id = c.district_id
  JOIN ulbs u ON u.id = c.ulb_id
  JOIN wards w ON w.id = c.ward_id
  JOIN complaint_types t ON t.id = c.type_id
  LEFT JOIN users sv ON sv.id = c.supervisor_id
  LEFT JOIN users wk ON wk.id = c.worker_id
  LEFT JOIN event_zones ez ON ez.id = c.event_zone_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(r: any) {
  return {
    id: r.id,
    complaintNo: formatComplaintNo(r.complaint_no),
    status: r.status,
    description: r.description,
    landmark: r.landmark,
    location: { lat: Number(r.lat), lng: Number(r.lng), accuracyM: r.gps_accuracy_m },
    wardSource: r.ward_source,
    wardMismatch: r.ward_mismatch,
    district: { id: r.district_id, name: r.district_name },
    ulb: { id: r.ulb_id, name: r.ulb_name, type: r.ulb_type },
    ward: { id: r.ward_id, number: r.ward_number },
    eventZone: r.event_zone_id ? { id: r.event_zone_id, name: r.event_zone_name } : null,
    areaId: r.area_id,
    type: { id: r.type_id, code: r.type_code, nameEn: r.type_name_en, nameHi: r.type_name_hi },
    supervisor: r.supervisor_id ? { id: r.supervisor_id, name: r.supervisor_name } : null,
    worker: r.worker_id ? { id: r.worker_id, name: r.worker_name } : null,
    duplicateOf: r.duplicate_of,
    reopenCount: r.reopen_count,
    escalated: r.escalated,
    resolutionRemark: r.resolution_remark,
    slaDueAt: r.sla_due_at,
    slaBreached: r.sla_breached,
    slaBreachedAt: r.sla_breached_at,
    escalatedAt: r.escalated_at,
    assignedAt: r.assigned_at,
    resolvedAt: r.resolved_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class ComplaintsService {
  constructor(
    private readonly ds: DataSource,
    private readonly media: MediaService,
    private readonly notifications: NotificationsService,
    private readonly zones: ZonesService,
  ) {}

  async create(citizen: AuthUser, dto: CreateComplaintDto) {
    const [{ count }] = await this.ds.query(
      `SELECT count(*)::int AS count FROM complaints WHERE citizen_id = $1 AND created_at > now() - interval '24 hours'`,
      [citizen.id],
    );
    if (count >= MAX_COMPLAINTS_PER_DAY) {
      throw new HttpException(`Daily limit of ${MAX_COMPLAINTS_PER_DAY} complaints reached`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const [type] = await this.ds.query(`SELECT id, sla_hours FROM complaint_types WHERE id = $1 AND active`, [dto.typeId]);
    if (!type) throw new BadRequestException('Unknown complaint type');

    const ward = await this.resolveWard(dto);

    const view = await this.ds.transaction(async (m) => {
      const [{ year }] = await m.query(`SELECT EXTRACT(year FROM now() AT TIME ZONE 'Asia/Kolkata')::int AS year`);
      const [{ last_value: seq }] = await m.query(
        `INSERT INTO complaint_seq (ulb_id, year, last_value) VALUES ($1, $2, 1)
         ON CONFLICT (ulb_id, year) DO UPDATE SET last_value = complaint_seq.last_value + 1
         RETURNING last_value`,
        [ward.ulb_id, year],
      );
      if (seq > SEQ_MAX) throw new ConflictException('Complaint sequence exhausted for this ULB and year');
      const complaintNo = buildComplaintNo(ward.district_lgd, ward.ulb_lgd, year, seq);

      // Inside an active event zone: the zone's supervisor and the tighter deadline apply.
      const zone = await this.zones.zoneFor(m, ward.ulb_id, dto.lat, dto.lng);
      const supervisorId: string | null = zone?.supervisor_id ?? ward.supervisor_id;
      const slaHours = zone?.sla_hours ? Math.min(zone.sla_hours, type.sla_hours) : type.sla_hours;
      const [row] = await m.query(
        `INSERT INTO complaints (complaint_no, citizen_id, district_id, ulb_id, ward_id, area_id, ward_source, ward_mismatch,
                                 type_id, landmark, description, location, gps_accuracy_m, status, sla_due_at, event_zone_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, ST_SetSRID(ST_MakePoint($13, $12), 4326), $14, 'PENDING',
                 now() + make_interval(hours => $15), $16)
         RETURNING id`,
        [
          complaintNo, citizen.id, ward.district_id, ward.ulb_id, ward.id, ward.area_id, ward.source, ward.mismatch,
          type.id, dto.landmark || null, dto.description, dto.lat, dto.lng, dto.gpsAccuracyM ?? null, slaHours, zone?.id ?? null,
        ],
      );
      const proof = await this.media.attach(m, citizen, row.id, MediaStage.COMPLAINT, dto.mediaIds, { requireAny: true });
      await this.event(m, row.id, ComplaintAction.CREATE, null, ComplaintStatus.PENDING, citizen.id, null, {
        wardSource: ward.source, wardMismatch: ward.mismatch, media: proof, eventZoneId: zone?.id,
      });
      if (supervisorId) {
        // Auto-route to the area supervisor; with no supervisor it waits in the Sub Admin's PENDING queue.
        const to = transition(ComplaintAction.ROUTE, ComplaintStatus.PENDING, 'SYSTEM');
        await m.query(`UPDATE complaints SET status = $2, supervisor_id = $3, assigned_at = now() WHERE id = $1`, [row.id, to, supervisorId]);
        await this.event(m, row.id, ComplaintAction.ROUTE, ComplaintStatus.PENDING, to, null, null, { supervisorId });
      }
      await this.notifications.notify(m, [citizen.id], templates.registered(complaintNo), row.id);
      const staff = supervisorId ? [supervisorId] : await this.notifications.subAdminsOf(m, ward.ulb_id);
      await this.notifications.notify(m, staff, templates.newInArea(complaintNo), row.id);
      return this.view(m, row.id);
    });
    await this.notifications.kick();
    return view;
  }

  async list(user: AuthUser, q: ListComplaintsQuery) {
    const params: unknown[] = [];
    const where = [scopeFilter(user, params)];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status) add('c.status = ?', q.status);
    if (q.ulbId) add('c.ulb_id = ?', q.ulbId);
    if (q.wardId) add('c.ward_id = ?', q.wardId);
    if (q.typeId) add('c.type_id = ?', q.typeId);
    if (q.eventZoneId) add('c.event_zone_id = ?', q.eventZoneId);
    if (q.from) add('c.created_at >= ?', q.from);
    if (q.to) add('c.created_at < ?', q.to);
    if (q.escalated !== undefined) add('c.escalated = ?', q.escalated);
    if (q.open) where.push(`c.status IN ('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`);
    if (q.overdue) where.push(`c.status IN ('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED') AND c.sla_due_at < now()`);
    const whereSql = where.join(' AND ');
    const [{ total }] = await this.ds.query(`SELECT count(*)::int AS total FROM complaints c WHERE ${whereSql}`, params);
    const rows = await this.ds.query(
      `SELECT ${VIEW_COLUMNS} ${VIEW_JOINS} WHERE ${whereSql}
        ORDER BY c.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      params,
    );
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map(toView) };
  }

  async get(user: AuthUser, id: string) {
    const params: unknown[] = [id];
    const [row] = await this.ds.query(`SELECT ${VIEW_COLUMNS} ${VIEW_JOINS} WHERE c.id = $1 AND ${scopeFilter(user, params)}`, params);
    if (!row) throw new NotFoundException('Complaint not found');
    const events = await this.ds.query(
      `SELECT e.action, e.from_status AS "fromStatus", e.to_status AS "toStatus", e.remark, e.created_at AS "at",
              a.role AS "actorRole", CASE WHEN a.role = 'CITIZEN' THEN NULL ELSE a.name END AS "actorName"
         FROM complaint_events e LEFT JOIN users a ON a.id = e.actor_id
        WHERE e.complaint_id = $1 ORDER BY e.id`,
      [id],
    );
    const feedback = await this.ds.query(
      `SELECT rating, remark, reopen_requested AS "reopenRequested", created_at AS "createdAt"
         FROM feedback WHERE complaint_id = $1 ORDER BY created_at`,
      [id],
    );
    return { ...toView(row), events, feedback };
  }

  /** Track by complaint number (citizen's own complaints, or staff within scope). */
  async getByNumber(user: AuthUser, complaintNo: string) {
    const no = normalizeComplaintNo(complaintNo);
    if (!no) throw new NotFoundException('Complaint not found');
    const params: unknown[] = [no];
    const [row] = await this.ds.query(`SELECT c.id FROM complaints c WHERE c.complaint_no = $1 AND ${scopeFilter(user, params)}`, params);
    if (!row) throw new NotFoundException('Complaint not found');
    return this.get(user, row.id);
  }

  async assign(user: AuthUser, id: string, dto: AssignDto) {
    if (!dto.workerId && !dto.supervisorId) throw new BadRequestException('workerId or supervisorId is required');
    if (dto.supervisorId && user.role !== Role.SUB_ADMIN) throw new BadRequestException('Only a Sub Admin can change the supervisor');
    return this.act(user, id, ComplaintAction.ASSIGN, async (m, c, to) => {
      const workerId = dto.workerId ? await this.assertStaffOfUlb(m, dto.workerId, Role.WORKER, c.ulb_id) : c.worker_id;
      const supervisorId = dto.supervisorId
        ? await this.assertStaffOfUlb(m, dto.supervisorId, Role.SUPERVISOR, c.ulb_id)
        : (c.supervisor_id ?? (user.role === Role.SUPERVISOR ? user.id : null));
      await m.query(
        `UPDATE complaints SET status = $2, worker_id = $3, supervisor_id = $4, assigned_at = COALESCE(assigned_at, now()) WHERE id = $1`,
        [c.id, to, workerId, supervisorId],
      );
      return { remark: dto.remark, meta: { workerId, supervisorId } };
    });
  }

  /** Workers must prove field work with in-app photos; supervisors may add them (staff app) or act by remark (web). */
  private proofRules(user: AuthUser, c: ComplaintRow) {
    return { requirePhoto: user.role === Role.WORKER, capturedAfter: new Date(c.created_at) };
  }

  async start(user: AuthUser, id: string, dto: StartWorkDto) {
    return this.act(user, id, ComplaintAction.START, async (m, c, to) => {
      await m.query(`UPDATE complaints SET status = $2 WHERE id = $1`, [c.id, to]);
      const media = await this.media.attach(m, user, c.id, MediaStage.WORK_START, dto.mediaIds, this.proofRules(user, c));
      return { remark: dto.remark, meta: { ...(await this.geoMeta(m, c.id, dto.location)), media } };
    });
  }

  async resolve(user: AuthUser, id: string, dto: ResolveDto) {
    return this.act(user, id, ComplaintAction.RESOLVE, async (m, c, to) => {
      await m.query(`UPDATE complaints SET status = $2, resolved_at = now(), resolution_remark = $3 WHERE id = $1`, [c.id, to, dto.remark]);
      const media = await this.media.attach(m, user, c.id, MediaStage.RESOLUTION, dto.mediaIds, this.proofRules(user, c));
      return { remark: dto.remark, meta: { ...(await this.geoMeta(m, c.id, dto.location)), media } };
    });
  }

  /** Before/after evidence with short-lived signed URLs, for anyone allowed to see the complaint. */
  async listMedia(user: AuthUser, id: string) {
    const params: unknown[] = [id];
    const [row] = await this.ds.query(`SELECT c.id FROM complaints c WHERE c.id = $1 AND ${scopeFilter(user, params)}`, params);
    if (!row) throw new NotFoundException('Complaint not found');
    return this.media.listForComplaint(id);
  }

  async reject(user: AuthUser, id: string, dto: RejectDto) {
    return this.act(user, id, ComplaintAction.REJECT, async (m, c, to) => {
      await m.query(`UPDATE complaints SET status = $2, closed_at = now() WHERE id = $1`, [c.id, to]);
      return { remark: dto.reason };
    });
  }

  async markDuplicate(user: AuthUser, id: string, dto: DuplicateDto) {
    if (dto.duplicateOfId === id) throw new BadRequestException('A complaint cannot duplicate itself');
    return this.act(user, id, ComplaintAction.MARK_DUPLICATE, async (m, c, to) => {
      const [orig] = await m.query(
        `SELECT id FROM complaints WHERE id = $1 AND ulb_id = $2 AND status NOT IN ('DUPLICATE','REJECTED')`,
        [dto.duplicateOfId, c.ulb_id],
      );
      if (!orig) throw new BadRequestException('Original complaint must be an open or resolved complaint of the same ULB');
      await m.query(`UPDATE complaints SET status = $2, duplicate_of = $3, closed_at = now() WHERE id = $1`, [c.id, to, orig.id]);
      return { remark: dto.remark, meta: { duplicateOf: orig.id } };
    });
  }

  /** Citizen rates the resolution; a low rating may reopen the complaint. */
  async feedback(user: AuthUser, id: string, dto: FeedbackDto) {
    if (dto.reopen && dto.rating > 2) throw new BadRequestException('Reopen is only possible with a rating of 1 or 2');
    const action = dto.reopen ? ComplaintAction.REOPEN : ComplaintAction.CLOSE;
    return this.act(user, id, action, async (m, c, to) => {
      if (!c.resolved_within_window) throw new BadRequestException(`Feedback window of ${FEEDBACK_WINDOW_DAYS} days has passed`);
      await m.query(
        `INSERT INTO feedback (complaint_id, citizen_id, rating, remark, reopen_requested) VALUES ($1,$2,$3,$4,$5)`,
        [c.id, user.id, dto.rating, dto.remark ?? null, !!dto.reopen],
      );
      if (dto.reopen) {
        const escalate = c.reopen_count + 1 > MAX_REOPENS;
        await m.query(
          `UPDATE complaints SET status = $2, reopen_count = reopen_count + 1, escalated = escalated OR $3,
                  resolved_at = NULL, sla_breached_at = NULL, escalated_at = NULL,
                  sla_due_at = now() + (SELECT make_interval(hours => sla_hours) FROM complaint_types WHERE id = $4)
            WHERE id = $1`,
          [c.id, to, escalate, c.type_id],
        );
        return { remark: dto.remark, meta: { rating: dto.rating, escalated: escalate } };
      }
      await m.query(`UPDATE complaints SET status = $2, closed_at = now() WHERE id = $1`, [c.id, to]);
      return { remark: dto.remark, meta: { rating: dto.rating } };
    });
  }

  /** Possible duplicates: same type, within 50 m, filed within 48 h of this one. */
  async duplicateCandidates(user: AuthUser, id: string) {
    const params: unknown[] = [id];
    const [c] = await this.ds.query(`SELECT c.id FROM complaints c WHERE c.id = $1 AND ${scopeFilter(user, params)}`, params);
    if (!c) throw new NotFoundException('Complaint not found');
    const candParams: unknown[] = [id, DUPLICATE_RADIUS_METERS, DUPLICATE_WINDOW_HOURS];
    const candScope = scopeFilter(user, candParams);
    const rows = await this.ds.query(
      `SELECT ${VIEW_COLUMNS}, ST_Distance(c.location::geography, base.location::geography) AS distance_m
         ${VIEW_JOINS}
         JOIN complaints base ON base.id = $1
        WHERE c.id <> base.id AND c.type_id = base.type_id AND c.ulb_id = base.ulb_id
          AND c.status NOT IN ('DUPLICATE','REJECTED')
          AND ST_DWithin(c.location::geography, base.location::geography, $2)
          AND c.created_at BETWEEN base.created_at - make_interval(hours => $3) AND base.created_at + make_interval(hours => $3)
          AND ${candScope}
        ORDER BY distance_m LIMIT 20`,
      candParams,
    );
    return rows.map((r: { distance_m: number }) => ({ ...toView(r), distanceM: Math.round(r.distance_m) }));
  }

  /** Close complaints the citizen did not rate within the feedback window (run by the scheduler). */
  async autoCloseStale(): Promise<number> {
    return this.ds.transaction(async (m) => {
      const rows = await mutateReturning(
        m,
        `UPDATE complaints SET status = 'CLOSED', closed_at = now()
          WHERE status = 'RESOLVED' AND resolved_at < now() - make_interval(days => $1)
          RETURNING id, complaint_no, citizen_id`,
        [FEEDBACK_WINDOW_DAYS],
      );
      for (const r of rows) {
        await this.event(m, r.id, ComplaintAction.AUTO_CLOSE, ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED, null, 'No feedback within window');
        await this.notifications.notify(m, [r.citizen_id], templates.closed(r.complaint_no), r.id);
      }
      return rows.length;
    }).finally(() => this.notifications.kick());
  }

  // ---- internals ----

  /**
   * Runs one status change: locks the row, checks the caller may see and act on the
   * complaint, validates the transition, applies the change and writes the event.
   */
  private async act(
    user: AuthUser,
    id: string,
    action: Exclude<TransitionAction, ComplaintAction.ROUTE | ComplaintAction.AUTO_CLOSE>,
    apply: (m: EntityManager, c: ComplaintRow, to: ComplaintStatus) => Promise<{ remark?: string; meta?: object }>,
  ) {
    const view = await this.ds.transaction(async (m) => {
      const params: unknown[] = [id, FEEDBACK_WINDOW_DAYS];
      const [c]: ComplaintRow[] = await m.query(
        `SELECT c.id, c.status, c.citizen_id, c.district_id, c.ulb_id, c.area_id, c.supervisor_id, c.worker_id,
                c.type_id, c.reopen_count, c.created_at,
                (c.resolved_at IS NOT NULL AND c.resolved_at > now() - make_interval(days => $2)) AS resolved_within_window
           FROM complaints c WHERE c.id = $1 AND ${scopeFilter(user, params)}
           FOR UPDATE`,
        params,
      );
      if (!c) throw new NotFoundException('Complaint not found');
      let to: ComplaintStatus;
      try {
        to = transition(action, c.status, user.role as Actor);
      } catch (err) {
        if (err instanceof InvalidTransitionError) throw new ConflictException(err.message);
        throw err;
      }
      const { remark, meta } = await apply(m, c, to);
      await m.query(`UPDATE complaints SET updated_at = now() WHERE id = $1`, [c.id]);
      await this.event(m, c.id, action, c.status, to, user.id, remark ?? null, meta);
      await this.notifyTransition(m, action, c);
      return this.view(m, c.id);
    });
    await this.notifications.kick();
    return view;
  }

  /** Who hears about each status change. Texts carry no personal data (see templates.ts). */
  private async notifyTransition(m: EntityManager, action: ComplaintAction, before: ComplaintRow) {
    const [after] = await m.query(
      `SELECT complaint_no, citizen_id, supervisor_id, worker_id, ulb_id, escalated FROM complaints WHERE id = $1`,
      [before.id],
    );
    const no: string = after.complaint_no;
    const n = (users: (string | null)[], content: ReturnType<typeof templates.registered>) =>
      this.notifications.notify(m, users, content, before.id);
    switch (action) {
      case ComplaintAction.ASSIGN:
        if (after.worker_id && after.worker_id !== before.worker_id) {
          await n([after.worker_id], templates.taskAssigned(no));
          if (!before.worker_id) await n([after.citizen_id], templates.assigned(no));
        }
        if (after.supervisor_id && after.supervisor_id !== before.supervisor_id) await n([after.supervisor_id], templates.newInArea(no));
        break;
      case ComplaintAction.START:
        await n([after.citizen_id], templates.started(no));
        break;
      case ComplaintAction.RESOLVE:
        await n([after.citizen_id], templates.resolved(no));
        break;
      case ComplaintAction.REJECT:
        await n([after.citizen_id], templates.rejected(no));
        break;
      case ComplaintAction.MARK_DUPLICATE:
        await n([after.citizen_id], templates.duplicate(no));
        break;
      case ComplaintAction.REOPEN:
        await n([after.supervisor_id, after.worker_id], templates.reopened(no));
        if (after.escalated) await n(await this.notifications.subAdminsOf(m, after.ulb_id), templates.escalated(no));
        break;
      default:
        break;
    }
  }

  private async event(
    m: EntityManager, complaintId: string, action: ComplaintAction, from: ComplaintStatus | null, to: ComplaintStatus,
    actorId: string | null, remark: string | null, meta?: object,
  ) {
    await m.query(
      `INSERT INTO complaint_events (complaint_id, action, from_status, to_status, actor_id, remark, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [complaintId, action, from, to, actorId, remark, meta ?? null],
    );
  }

  private async view(m: EntityManager, id: string) {
    const [row] = await m.query(`SELECT ${VIEW_COLUMNS} ${VIEW_JOINS} WHERE c.id = $1`, [id]);
    return toView(row);
  }

  /** Distance of the actor from the complaint; recorded on the event and flagged when outside the geofence. */
  private async geoMeta(m: EntityManager, complaintId: string, loc?: GeoPointDto) {
    if (!loc) return { locationProvided: false };
    const [{ d }] = await m.query(
      `SELECT ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography) AS d FROM complaints WHERE id = $1`,
      [complaintId, loc.lat, loc.lng],
    );
    return {
      locationProvided: true, lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM ?? null,
      distanceM: Math.round(d), outsideGeofence: d > RESOLUTION_GEOFENCE_METERS,
    };
  }

  private async assertStaffOfUlb(m: EntityManager, userId: string, role: Role, ulbId: string): Promise<string> {
    const [u] = await m.query(`SELECT id FROM users WHERE id = $1 AND role = $2 AND ulb_id = $3 AND status = 'ACTIVE'`, [userId, role, ulbId]);
    if (!u) throw new BadRequestException(`${role.toLowerCase()} must be an active ${role.toLowerCase()} of this ULB`);
    return u.id;
  }

  /**
   * Complaint location decides the ward, not the citizen's home ward.
   * GPS point-in-polygon first; a citizen-chosen ward overrides it but is flagged
   * when it lies more than WARD_MISMATCH_METERS from the GPS point.
   */
  private async resolveWard(dto: CreateComplaintDto) {
    const point = `ST_SetSRID(ST_MakePoint($2, $1), 4326)`;
    const base = `SELECT w.id, w.ulb_id, w.area_id, u.district_id, u.lgd_code AS ulb_lgd, d.lgd_code AS district_lgd,
                         (SELECT a.supervisor_id FROM areas a JOIN users s ON s.id = a.supervisor_id AND s.status = 'ACTIVE'
                           WHERE a.id = w.area_id) AS supervisor_id`;
    const joins = `FROM wards w JOIN ulbs u ON u.id = w.ulb_id JOIN districts d ON d.id = u.district_id
                   WHERE w.active AND u.active AND d.active`;

    if (dto.wardId) {
      const [ward] = await this.ds.query(
        `${base}, (w.geom IS NOT NULL AND ST_Distance(w.geom::geography, ${point}::geography) > $4) AS mismatch
         ${joins} AND w.id = $3`,
        [dto.lat, dto.lng, dto.wardId, WARD_MISMATCH_METERS],
      );
      if (!ward) throw new BadRequestException('Unknown ward');
      return { ...ward, source: WardSource.MANUAL };
    }
    const [ward] = await this.ds.query(`${base}, false AS mismatch ${joins} AND ST_Contains(w.geom, ${point}) LIMIT 1`, [dto.lat, dto.lng]);
    if (!ward) throw new BadRequestException('Could not detect the ward from GPS; please choose District, ULB and Ward');
    return { ...ward, source: WardSource.GPS };
  }
}
