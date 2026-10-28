import { db } from '@/db/connection';
import type { Db } from '@/db/sql';
import { buildComplaintNo, formatComplaintNo, normalizeComplaintNo, SEQ_MAX } from '@/lib/complaintNumber';
import { badRequest, conflict, notFound, tooMany } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { templates } from '@/lib/notificationTemplates';
import { InvalidTransitionError, transition, type ComplaintAction, type TransitionAction } from '@/lib/stateMachine';
import type { ComplaintStatus } from '@/lib/enums';
import { ComplaintModel, complaintScope, type ComplaintRow } from '@/models/ComplaintModel';
import { ComplaintTypeModel, WardModel, type WardForComplaint } from '@/models/MasterModel';
import { EventZoneModel } from '@/models/EventZoneModel';
import type { AuthUser } from '@/middleware/auth';
import { MediaService } from './MediaService';
import { NotificationService } from './NotificationService';

export const MAX_COMPLAINTS_PER_DAY = 10;
/** A manually chosen ward further than this from the GPS point is flagged for the supervisor. */
export const WARD_MISMATCH_METERS = 500;
/** Resolution recorded further than this from the complaint is flagged in quality reports. */
export const RESOLUTION_GEOFENCE_METERS = 100;
export const FEEDBACK_WINDOW_DAYS = 7;
export const MAX_REOPENS = 2;
export const DUPLICATE_RADIUS_METERS = 50;
export const DUPLICATE_WINDOW_HOURS = 48;

type Row = Record<string, any>;  
interface GeoPoint { lat: number; lng: number; accuracyM?: number }

function toView(r: Row) {
  return {
    id: r.id,
    complaintNo: formatComplaintNo(r.complaint_no),
    status: r.status,
    description: r.description,
    landmark: r.landmark,
    location: { lat: Number(r.lat), lng: Number(r.lng), accuracyM: r.gps_accuracy_m },
    wardSource: r.ward_source,
    wardMismatch: !!r.ward_mismatch,
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
    escalated: !!r.escalated,
    resolutionRemark: r.resolution_remark,
    slaDueAt: r.sla_due_at,
    slaBreached: !!r.sla_breached,
    slaBreachedAt: r.sla_breached_at,
    escalatedAt: r.escalated_at,
    assignedAt: r.assigned_at,
    resolvedAt: r.resolved_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function viewById(d: Db, id: string) {
  return toView((await ComplaintModel.findView(d, id))!);
}

/**
 * Complaint location decides the ward, not the citizen's home ward. GPS point-in-polygon first; a ward chosen by hand
 * overrides it but is flagged when it lies more than WARD_MISMATCH_METERS from the GPS point.
 */
async function resolveWard(d: Db, v: { lat: number; lng: number; wardId?: string }): Promise<WardForComplaint & { source: 'GPS' | 'MANUAL' }> {
  if (v.wardId) {
    const ward = await WardModel.forComplaint(d, v.wardId, v.lng, v.lat, WARD_MISMATCH_METERS);
    if (!ward) throw badRequest('Unknown ward');
    return { ...ward, source: 'MANUAL' };
  }
  const ward = await WardModel.forComplaintAt(d, v.lng, v.lat);
  if (!ward) throw badRequest('Could not detect the ward from GPS; please choose District, ULB and Ward');
  return { ...ward, source: 'GPS' };
}

async function assertStaffOfUlb(d: Db, userId: string, role: 'WORKER' | 'SUPERVISOR', ulbId: string): Promise<string> {
  const u = await ComplaintModel.staffOfUlb(d, userId, role, ulbId);
  if (!u) throw badRequest(`${role.toLowerCase()} must be an active ${role.toLowerCase()} of this ULB`);
  return u.id;
}

/** Distance of the actor from the complaint; recorded on the event and flagged when outside the geofence. */
async function geoMeta(d: Db, complaintId: string, loc?: GeoPoint) {
  if (!loc) return { locationProvided: false };
  const distance = await ComplaintModel.distanceTo(d, complaintId, loc.lng, loc.lat);
  return {
    locationProvided: true, lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM ?? null,
    distanceM: Math.round(distance), outsideGeofence: distance > RESOLUTION_GEOFENCE_METERS,
  };
}

/** Workers must prove field work with in-app photos; supervisors may add them (staff app) or act by remark (web). */
const proofRules = (user: AuthUser, c: ComplaintRow) => ({ requirePhoto: user.role === 'WORKER', capturedAfter: new Date(c.created_at) });

type Apply = (d: Db, c: ComplaintRow, to: ComplaintStatus) => Promise<{ remark?: string; meta?: object }>;

/**
 * Runs one status change: locks the row, checks the caller may see and act on the complaint, validates the
 * transition, applies the change and writes the event, all in one transaction.
 */
async function act(user: AuthUser, id: string, action: Exclude<TransitionAction, 'ROUTE' | 'AUTO_CLOSE'>, apply: Apply) {
  const view = await db().transaction(async (trx) => {
    const c = await ComplaintModel.lockForAction(trx, id, complaintScope(user), FEEDBACK_WINDOW_DAYS);
    if (!c) throw notFound('Complaint not found');
    let to: ComplaintStatus;
    try {
      to = transition(action, c.status, user.role);
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw conflict(err.message);
      throw err;
    }
    const { remark, meta } = await apply(trx, c, to);
    await ComplaintModel.insertEvent(trx, { complaintId: c.id, action, from: c.status, to, actorId: user.id, remark: remark ?? null, meta });
    await notifyTransition(trx, action, c);
    return viewById(trx, c.id);
  });
  await NotificationService.kick();
  return view;
}

/** Who hears about each status change. Texts carry no personal data (see notificationTemplates.ts). */
async function notifyTransition(d: Db, action: ComplaintAction, before: ComplaintRow) {
  const after = (await ComplaintModel.summary(d, before.id))!;
  const no = after.complaint_no;
  const n = (users: (string | null)[], content: ReturnType<typeof templates.registered>) => NotificationService.notify(d, users, content, before.id);
  switch (action) {
    case 'ASSIGN':
      if (after.worker_id && after.worker_id !== before.worker_id) {
        await n([after.worker_id], templates.taskAssigned(no));
        if (!before.worker_id) await n([after.citizen_id], templates.assigned(no));
      }
      if (after.supervisor_id && after.supervisor_id !== before.supervisor_id) await n([after.supervisor_id], templates.newInArea(no));
      break;
    case 'START':
      await n([after.citizen_id], templates.started(no));
      break;
    case 'RESOLVE':
      await n([after.citizen_id], templates.resolved(no));
      break;
    case 'REJECT':
      await n([after.citizen_id], templates.rejected(no));
      break;
    case 'MARK_DUPLICATE':
      await n([after.citizen_id], templates.duplicate(no));
      break;
    case 'REOPEN':
      await n([after.supervisor_id, after.worker_id], templates.reopened(no));
      if (after.escalated) await n(await NotificationService.subAdminsOf(d, after.ulb_id), templates.escalated(no));
      break;
    default:
      break;
  }
}

export const ComplaintService = {
  async create(
    citizen: AuthUser,
    v: { typeId: string; lat: number; lng: number; gpsAccuracyM?: number; wardId?: string; landmark?: string; description: string; mediaIds: string[] },
  ) {
    if ((await ComplaintModel.recentCountByCitizen(db(), citizen.id)) >= MAX_COMPLAINTS_PER_DAY) throw tooMany(`Daily limit of ${MAX_COMPLAINTS_PER_DAY} complaints reached`);
    const type = await ComplaintTypeModel.find(db(), v.typeId);
    if (!type || !type.active) throw badRequest('Unknown complaint type');
    const ward = await resolveWard(db(), v);
    const id = newId();

    const view = await db().transaction(async (trx) => {
      const { year, seq } = await ComplaintModel.nextSequence(trx, ward.ulb_id);
      if (seq > SEQ_MAX) throw conflict('Complaint sequence exhausted for this ULB and year');
      const complaintNo = buildComplaintNo(ward.district_lgd, ward.ulb_lgd, year, seq);

      // Inside an active event zone: the zone's supervisor and the tighter deadline apply.
      const zone = await EventZoneModel.zoneFor(trx, ward.ulb_id, v.lng, v.lat);
      const supervisorId = zone?.supervisor_id ?? ward.supervisor_id;
      const slaHours = zone?.sla_hours ? Math.min(zone.sla_hours, type.sla_hours) : type.sla_hours;
      await ComplaintModel.insert(trx, {
        id, complaintNo, citizenId: citizen.id, districtId: ward.district_id, ulbId: ward.ulb_id, wardId: ward.id, areaId: ward.area_id,
        wardSource: ward.source, wardMismatch: ward.mismatch, typeId: type.id, landmark: v.landmark || null, description: v.description,
        lat: v.lat, lng: v.lng, gpsAccuracyM: v.gpsAccuracyM ?? null, slaHours, eventZoneId: zone?.id ?? null,
      });
      const proof = await MediaService.attach(trx, citizen, id, 'COMPLAINT', v.mediaIds, { requireAny: true });
      await ComplaintModel.insertEvent(trx, {
        complaintId: id, action: 'CREATE', from: null, to: 'PENDING', actorId: citizen.id, remark: null,
        meta: { wardSource: ward.source, wardMismatch: ward.mismatch, media: proof, eventZoneId: zone?.id ?? null },
      });
      if (supervisorId) {
        // Auto-route to the area supervisor; with no supervisor it waits in the Sub Admin's PENDING queue.
        const to = transition('ROUTE', 'PENDING', 'SYSTEM');
        await ComplaintModel.setRouted(trx, id, supervisorId);
        await ComplaintModel.insertEvent(trx, { complaintId: id, action: 'ROUTE', from: 'PENDING', to, actorId: null, remark: null, meta: { supervisorId } });
      }
      await NotificationService.notify(trx, [citizen.id], templates.registered(complaintNo), id);
      const staff = supervisorId ? [supervisorId] : await NotificationService.subAdminsOf(trx, ward.ulb_id);
      await NotificationService.notify(trx, staff, templates.newInArea(complaintNo), id);
      return viewById(trx, id);
    });
    await NotificationService.kick();
    return view;
  },

  async list(user: AuthUser, q: { page: number; pageSize: number } & Parameters<typeof ComplaintModel.list>[2]) {
    const { total, rows } = await ComplaintModel.list(db(), complaintScope(user), q, q.pageSize, (q.page - 1) * q.pageSize);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map(toView) };
  },

  async get(user: AuthUser, id: string) {
    const row = await ComplaintModel.findView(db(), id, complaintScope(user));
    if (!row) throw notFound('Complaint not found');
    const [events, feedback] = await Promise.all([ComplaintModel.events(db(), id), ComplaintModel.feedbackOf(db(), id)]);
    return { ...toView(row), events, feedback };
  },

  /** Track by complaint number (the citizen's own complaints, or staff within their scope). */
  async getByNumber(user: AuthUser, complaintNo: string) {
    const no = normalizeComplaintNo(complaintNo);
    if (!no) throw notFound('Complaint not found');
    const id = await ComplaintModel.idByNumber(db(), no, complaintScope(user));
    if (!id) throw notFound('Complaint not found');
    return ComplaintService.get(user, id);
  },

  async listMedia(user: AuthUser, id: string, origin: string) {
    if (!(await ComplaintModel.visible(db(), id, complaintScope(user)))) throw notFound('Complaint not found');
    return MediaService.listForComplaint(id, origin);
  },

  async assign(user: AuthUser, id: string, v: { workerId?: string; supervisorId?: string; remark?: string }) {
    if (!v.workerId && !v.supervisorId) throw badRequest('workerId or supervisorId is required');
    if (v.supervisorId && user.role !== 'SUB_ADMIN') throw badRequest('Only a Sub Admin can change the supervisor');
    return act(user, id, 'ASSIGN', async (trx, c) => {
      const workerId = v.workerId ? await assertStaffOfUlb(trx, v.workerId, 'WORKER', c.ulb_id) : c.worker_id;
      const supervisorId = v.supervisorId
        ? await assertStaffOfUlb(trx, v.supervisorId, 'SUPERVISOR', c.ulb_id)
        : (c.supervisor_id ?? (user.role === 'SUPERVISOR' ? user.id : null));
      await ComplaintModel.setAssigned(trx, c.id, { workerId, supervisorId });
      return { remark: v.remark, meta: { workerId, supervisorId } };
    });
  },

  start(user: AuthUser, id: string, v: { remark?: string; mediaIds?: string[]; location?: GeoPoint }) {
    return act(user, id, 'START', async (trx, c) => {
      await ComplaintModel.setStarted(trx, c.id);
      const media = await MediaService.attach(trx, user, c.id, 'WORK_START', v.mediaIds, proofRules(user, c));
      return { remark: v.remark, meta: { ...(await geoMeta(trx, c.id, v.location)), media } };
    });
  },

  resolve(user: AuthUser, id: string, v: { remark: string; mediaIds?: string[]; location?: GeoPoint }) {
    return act(user, id, 'RESOLVE', async (trx, c) => {
      await ComplaintModel.setResolved(trx, c.id, v.remark);
      const media = await MediaService.attach(trx, user, c.id, 'RESOLUTION', v.mediaIds, proofRules(user, c));
      return { remark: v.remark, meta: { ...(await geoMeta(trx, c.id, v.location)), media } };
    });
  },

  reject(user: AuthUser, id: string, v: { reason: string }) {
    return act(user, id, 'REJECT', async (trx, c) => {
      await ComplaintModel.setRejected(trx, c.id);
      return { remark: v.reason };
    });
  },

  markDuplicate(user: AuthUser, id: string, v: { duplicateOfId: string; remark?: string }) {
    if (v.duplicateOfId === id) throw badRequest('A complaint cannot duplicate itself');
    return act(user, id, 'MARK_DUPLICATE', async (trx, c) => {
      const original = await ComplaintModel.originalFor(trx, v.duplicateOfId, c.ulb_id);
      if (!original) throw badRequest('Original complaint must be an open or resolved complaint of the same ULB');
      await ComplaintModel.setDuplicate(trx, c.id, original.id);
      return { remark: v.remark, meta: { duplicateOf: original.id } };
    });
  },

  /** The citizen rates the resolution; a low rating may reopen the complaint. */
  feedback(user: AuthUser, id: string, v: { rating: number; remark?: string; reopen?: boolean }) {
    if (v.reopen && v.rating > 2) throw badRequest('Reopen is only possible with a rating of 1 or 2');
    return act(user, id, v.reopen ? 'REOPEN' : 'CLOSE', async (trx, c) => {
      if (!c.resolved_within_window) throw badRequest(`Feedback window of ${FEEDBACK_WINDOW_DAYS} days has passed`);
      await ComplaintModel.insertFeedback(trx, { complaintId: c.id, citizenId: user.id, rating: v.rating, remark: v.remark || null, reopen: !!v.reopen });
      if (v.reopen) {
        const escalate = c.reopen_count + 1 > MAX_REOPENS;
        await ComplaintModel.setReopened(trx, c.id, escalate, c.type_id);
        return { remark: v.remark, meta: { rating: v.rating, escalated: escalate } };
      }
      await ComplaintModel.setClosed(trx, c.id);
      return { remark: v.remark, meta: { rating: v.rating } };
    });
  },

  /** Possible duplicates: same type, within 50 m, filed within 48 h of this one. */
  async duplicateCandidates(user: AuthUser, id: string) {
    const scope = complaintScope(user);
    if (!(await ComplaintModel.visible(db(), id, scope))) throw notFound('Complaint not found');
    const rows = await ComplaintModel.duplicateCandidates(db(), id, scope, DUPLICATE_RADIUS_METERS, DUPLICATE_WINDOW_HOURS);
    return rows.map((r) => ({ ...toView(r), distanceM: Math.round(Number(r.distance_m)) }));
  },

  /** Close complaints the citizen did not rate within the feedback window (run by the background worker). */
  async autoCloseStale(): Promise<number> {
    const closed = await db().transaction(async (trx) => {
      const rows = await ComplaintModel.staleResolved(trx, FEEDBACK_WINDOW_DAYS);
      for (const r of rows) {
        await ComplaintModel.setClosed(trx, r.id);
        await ComplaintModel.insertEvent(trx, { complaintId: r.id, action: 'AUTO_CLOSE', from: 'RESOLVED', to: 'CLOSED', actorId: null, remark: 'No feedback within window' });
        await NotificationService.notify(trx, [r.citizen_id], templates.closed(r.complaint_no), r.id);
      }
      return rows.length;
    });
    if (closed) await NotificationService.kick();
    return closed;
  },
};
