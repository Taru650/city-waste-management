import { db } from '@/db/connection';
import type { Db } from '@/db/sql';
import type { GeoJsonPolygon } from '@/lib/geo';
import { badRequest, isGeometryError, notFound } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { templates } from '@/lib/notificationTemplates';
import { AuditModel } from '@/models/AuditModel';
import { ComplaintModel } from '@/models/ComplaintModel';
import { WardModel } from '@/models/MasterModel';
import { zoneScope, ZoneModel, type ZoneValues } from '@/models/ZoneModel';
import type { AuthUser } from '@/middleware/auth';
import { NotificationService } from './NotificationService';
import { assertCanManageUlb } from './ScopeService';

/** Longest event (Kumbh-scale melas run about 2 months); longer needs are ward/area changes, not events. */
export const MAX_ZONE_DAYS = 92;
/** 100 km²: an event, not a city. */
export const MAX_ZONE_AREA_M2 = 100_000_000;

async function validate(d: Db, ulbId: string, v: ZoneValues, selfId: string | null, opts: { allowPastEnd?: boolean } = {}) {
  if (!(v.endsAt > v.startsAt)) throw badRequest('endsAt must be after startsAt');
  if (!opts.allowPastEnd && v.endsAt <= new Date()) throw badRequest('endsAt must be in the future');
  if (v.endsAt.getTime() - v.startsAt.getTime() > MAX_ZONE_DAYS * 86_400_000) throw badRequest(`An event zone can last at most ${MAX_ZONE_DAYS} days`);

  let g;
  try {
    g = await ZoneModel.checkGeometry(d, ulbId, v.boundary as GeoJsonPolygon);
  } catch (err) {
    if (!isGeometryError(err)) throw err;
  }
  if (!g || !g.valid) throw badRequest('Zone polygon is not valid (self-intersecting or unclosed ring)');
  if (Number(g.area) > MAX_ZONE_AREA_M2) throw badRequest('Zone is larger than 100 km²');
  if (!g.in_ulb) throw badRequest('Zone must overlap the wards of its ULB');

  // Two active zones covering the same place at the same time would make routing ambiguous.
  const clash = await ZoneModel.clash(d, ulbId, selfId, v.startsAt, v.endsAt, v.boundary);
  if (clash) throw badRequest(`Overlaps event zone "${clash}" at the same time`);

  if (v.supervisorId) {
    const s = await ZoneModel.supervisorOk(d, v.supervisorId, ulbId);
    if (!s) throw badRequest('Supervisor must be an active supervisor of this ULB');
    if (s.access_expires_at && new Date(s.access_expires_at) < v.endsAt) throw badRequest("The supervisor's access ends before the zone does");
  }
}

export const ZoneService = {
  list: (user: AuthUser, q: { ulbId?: string; when: 'current' | 'upcoming' | 'past' | 'all' }) => ZoneModel.list(db(), zoneScope(user), q),

  async get(user: AuthUser, id: string) {
    const zone = await ZoneModel.findVisible(db(), id, zoneScope(user));
    if (!zone) throw notFound('Event zone not found');
    return { ...zone, stats: await ZoneModel.stats(db(), id) };
  },

  async create(user: AuthUser, v: { ulbId: string; name: string; boundary: GeoJsonPolygon; startsAt: string; endsAt: string; supervisorId?: string; slaHours?: number }) {
    const ulb = await assertCanManageUlb(db(), user, user.role === 'SUB_ADMIN' ? user.ulbId! : v.ulbId);
    const values: ZoneValues = {
      name: v.name, boundary: v.boundary, startsAt: new Date(v.startsAt), endsAt: new Date(v.endsAt), supervisorId: v.supervisorId ?? null, slaHours: v.slaHours ?? null,
    };
    const id = newId();
    await db().transaction(async (trx) => {
      // One zone change per ULB at a time, taken before any read, so two overlapping requests cannot both pass the clash check.
      await WardModel.lockUlb(trx, ulb.id);
      await validate(trx, ulb.id, values, null);
      await ZoneModel.insert(trx, { ...values, id, ulbId: ulb.id, createdBy: user.id });
      await AuditModel.log(trx, { actorId: user.id, action: 'EVENT_ZONE_CREATED', entity: 'event_zone', entityId: id, meta: { ulbId: ulb.id, name: values.name } });
    });
    return { id };
  },

  async update(
    user: AuthUser,
    id: string,
    v: { name?: string; boundary?: GeoJsonPolygon; startsAt?: string; endsAt?: string; supervisorId?: string | null; slaHours?: number | null; active?: boolean },
  ) {
    await db().transaction(async (trx) => {
      const z = await ZoneModel.lock(trx, id);
      if (!z) throw notFound('Event zone not found');
      await assertCanManageUlb(trx, user, z.ulb_id);
      await WardModel.lockUlb(trx, z.ulb_id);
      const values: ZoneValues = {
        name: v.name ?? z.name,
        boundary: (v.boundary ?? (typeof z.boundary === 'string' ? JSON.parse(z.boundary) : z.boundary)) as GeoJsonPolygon,
        startsAt: v.startsAt ? new Date(v.startsAt) : z.starts_at,
        endsAt: v.endsAt ? new Date(v.endsAt) : z.ends_at,
        supervisorId: v.supervisorId === undefined ? z.supervisor_id : v.supervisorId,
        slaHours: v.slaHours === undefined ? z.sla_hours : v.slaHours,
      };
      const active = v.active ?? z.active;
      if (active) await validate(trx, z.ulb_id, values, id, { allowPastEnd: !v.endsAt });
      await ZoneModel.update(trx, id, { ...values, active });
      await AuditModel.log(trx, {
        actorId: user.id, action: active ? 'EVENT_ZONE_UPDATED' : 'EVENT_ZONE_CANCELLED', entity: 'event_zone', entityId: id, meta: { ...v, boundary: undefined },
      });
    });
    return { id };
  },

  /**
   * Ended or cancelled zones: open complaints still with the zone supervisor go back to the area supervisor (or the
   * Sub Admin queue), so nothing is stranded with a temporary account.
   */
  async handover(): Promise<number> {
    let moved = 0;
    for (const z of await ZoneModel.dueForHandover(db())) {
      moved += await db().transaction(async (trx) => {
        if (!(await ZoneModel.lockForHandover(trx, z.id))) return 0;
        const rows = await ZoneModel.complaintsToHandBack(trx, z.id, z.supervisor_id);
        for (const c of rows) {
          await ZoneModel.setComplaintSupervisor(trx, c.id, c.new_supervisor);
          await ComplaintModel.insertEvent(trx, {
            complaintId: c.id, action: 'HANDOVER', from: c.status, to: c.status, actorId: null, remark: null,
            meta: { eventZoneId: z.id, from: z.supervisor_id, to: c.new_supervisor },
          });
          const to = c.new_supervisor ? [c.new_supervisor] : await NotificationService.subAdminsOf(trx, z.ulb_id);
          await NotificationService.notify(trx, to, templates.handedOver(c.complaint_no, z.name), c.id);
        }
        await ZoneModel.markHandedOver(trx, z.id);
        return rows.length;
      });
    }
    if (moved) await NotificationService.kick();
    return moved;
  },
};
