import { db } from '@/db/connection';
import type { Db } from '@/db/sql';
import { badRequest, conflict, forbidden, isDuplicateKey, isGeometryError, notFound } from '@/lib/errors';
import { newId } from '@/lib/ids';
import type { GeoJsonPolygon } from '@/lib/geo';
import { AuditModel } from '@/models/AuditModel';
import { AreaModel, ComplaintTypeModel, DistrictModel, UlbModel, WardModel } from '@/models/MasterModel';
import type { AuthUser } from '@/middleware/auth';
import { assertCanManageUlb } from './ScopeService';

/**
 * Wards of one ULB may share edges but not area: a GPS point inside two wards would be routed to either
 * supervisor. Slivers up to this size are tolerated, because boundaries digitised by hand rarely meet exactly.
 */
export const WARD_OVERLAP_TOLERANCE_M2 = 100;

async function assertValidBoundary(d: Db, geo: GeoJsonPolygon) {
  let ok = false;
  try {
    ok = await WardModel.isValidGeometry(d, geo);
  } catch (err) {
    if (!isGeometryError(err)) throw err;
  }
  if (!ok) throw badRequest('Boundary polygon is not valid (self-intersecting or unclosed ring)');
}

/** Checks the ward's saved state inside the caller's transaction; throwing rolls the change back. */
async function assertNoWardOverlap(d: Db, wardId: string) {
  const overlaps = await WardModel.overlaps(d, wardId, WARD_OVERLAP_TOLERANCE_M2);
  if (overlaps.length) {
    const list = overlaps.map((o) => (o.overlapM2 === null ? `ward ${o.number} (edges almost coincide)` : `ward ${o.number} (${o.overlapM2.toLocaleString('en-IN')} m²)`)).join(', ');
    throw badRequest(
      `Boundary overlaps ${list}. Wards of a ULB must not overlap. If wards only touch along a shared edge, give both wards identical vertices on that edge (snap the boundaries) and upload again.`,
    );
  }
}

async function assertWardsBelongToUlb(d: Db, ulbId: string, wardIds: string[]) {
  const distinct = [...new Set(wardIds)];
  if ((await AreaModel.countWardsInUlb(d, ulbId, distinct)) !== distinct.length) throw badRequest('All wards must belong to the same ULB');
}

async function assertSupervisorOfUlb(d: Db, supervisorId: string, ulbId: string) {
  if (!(await AreaModel.isSupervisorOf(d, supervisorId, ulbId))) throw badRequest('Supervisor must be an active supervisor of this ULB');
}

async function unique<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('Already exists');
    throw err;
  }
}

export const MasterService = {
  // ---- Public lookups (registration and complaint dropdowns) ----
  listDistricts: () => DistrictModel.list(db()),
  listUlbs: (districtId: string) => UlbModel.list(db(), districtId),
  async listWards(ulbId: string) {
    const rows = await WardModel.list(db(), ulbId);
    return rows.map((r) => ({ ...r, hasBoundary: !!r.hasBoundary }));
  },
  async listComplaintTypes(includeInactive = false) {
    const rows = await ComplaintTypeModel.list(db(), includeInactive);
    return rows.map((r) => ({ ...r, active: !!r.active }));
  },

  /** Ward boundaries of a ULB as a GeoJSON FeatureCollection (maps in the portal). */
  async wardBoundaries(user: AuthUser, ulbId: string) {
    if (user.role === 'SUPERVISOR') {
      if (user.ulbId !== ulbId) throw forbidden('Outside your jurisdiction');
    } else {
      await assertCanManageUlb(db(), user, ulbId);
    }
    return { type: 'FeatureCollection' as const, features: await WardModel.boundaries(db(), ulbId) };
  },

  /** Reverse-geocode a GPS point to ward → ULB → district using ward polygons. */
  async locate(lat: number, lng: number) {
    const row = await WardModel.locate(db(), lat, lng);
    if (!row) throw notFound('No ward boundary covers this location; choose the ward manually');
    const { areaId: _a, districtIdRaw: _d, ...visible } = row as Record<string, unknown>;
    void _a;
    void _d;
    return visible;
  },

  // ---- Administration ----
  async createDistrict(user: AuthUser, v: { lgdCode: number; census2011Code?: number; name: string; nameHi?: string }) {
    const id = newId();
    await unique(() => DistrictModel.insert(db(), { id, ...v }));
    await AuditModel.log(db(), { actorId: user.id, action: 'DISTRICT_CREATED', entity: 'district', entityId: id, meta: v });
    return { id };
  },

  async createUlb(user: AuthUser, v: { districtId: string; lgdCode: number; type: string; name: string; nameHi?: string; boundary?: GeoJsonPolygon }) {
    if (user.role === 'DISTRICT_ADMIN' && v.districtId !== user.districtId) throw forbidden('Outside your jurisdiction');
    if (!(await DistrictModel.find(db(), v.districtId))) throw notFound('District not found');
    if (v.boundary) await assertValidBoundary(db(), v.boundary);
    const id = newId();
    await unique(() =>
      db().transaction(async (trx) => {
        await UlbModel.insert(trx, { id, districtId: v.districtId, lgdCode: v.lgdCode, type: v.type as never, name: v.name, nameHi: v.nameHi });
        if (v.boundary) await UlbModel.setBoundary(trx, id, v.boundary);
        await AuditModel.log(trx, { actorId: user.id, action: 'ULB_CREATED', entity: 'ulb', entityId: id, meta: { ...v, boundary: !!v.boundary } });
      }),
    );
    return { id };
  },

  async createWard(user: AuthUser, v: { ulbId: string; number: number; name?: string; boundary?: GeoJsonPolygon }) {
    await assertCanManageUlb(db(), user, v.ulbId);
    if (v.boundary) await assertValidBoundary(db(), v.boundary);
    const id = newId();
    await unique(() =>
      db().transaction(async (trx) => {
        // Lock the ULB before any read: one boundary change per ULB at a time, and the overlap check below
        // then sees every ward committed before us (the snapshot is taken after the lock is granted).
        await WardModel.lockUlb(trx, v.ulbId);
        await WardModel.insert(trx, { id, ulbId: v.ulbId, number: v.number, name: v.name });
        if (v.boundary) {
          await WardModel.setBoundary(trx, id, v.boundary);
          await assertNoWardOverlap(trx, id);
        }
        await AuditModel.log(trx, { actorId: user.id, action: 'WARD_CREATED', entity: 'ward', entityId: id, meta: { ulbId: v.ulbId, number: v.number } });
      }),
    );
    return { id };
  },

  async updateWard(user: AuthUser, wardId: string, v: { name?: string; boundary?: GeoJsonPolygon; active?: boolean }) {
    const ward = await WardModel.find(db(), wardId);
    if (!ward) throw notFound('Ward not found');
    await assertCanManageUlb(db(), user, ward.ulb_id);
    if (v.boundary) await assertValidBoundary(db(), v.boundary);
    await db().transaction(async (trx) => {
      await WardModel.lockUlb(trx, ward.ulb_id);
      await WardModel.update(trx, wardId, { name: v.name, active: v.active });
      if (v.boundary) await WardModel.setBoundary(trx, wardId, v.boundary);
      // A new boundary, or a ward switched back on, must not cover another active ward.
      if (v.boundary || v.active === true) await assertNoWardOverlap(trx, wardId);
      await AuditModel.log(trx, { actorId: user.id, action: 'WARD_UPDATED', entity: 'ward', entityId: wardId, meta: { ...v, boundary: !!v.boundary } });
    });
    return { id: wardId };
  },

  async listAreas(user: AuthUser, ulbId: string) {
    await assertCanManageUlb(db(), user, ulbId);
    return AreaModel.listWithWards(db(), ulbId);
  },

  async createArea(user: AuthUser, v: { ulbId: string; name: string; supervisorId?: string; wardIds: string[] }) {
    await assertCanManageUlb(db(), user, v.ulbId);
    const id = newId();
    await unique(() =>
      db().transaction(async (trx) => {
        if (v.supervisorId) await assertSupervisorOfUlb(trx, v.supervisorId, v.ulbId);
        await assertWardsBelongToUlb(trx, v.ulbId, v.wardIds);
        await AreaModel.insert(trx, { id, ulbId: v.ulbId, name: v.name, supervisorId: v.supervisorId });
        await AreaModel.assignWards(trx, id, v.ulbId, v.wardIds);
        await AuditModel.log(trx, { actorId: user.id, action: 'AREA_CREATED', entity: 'area', entityId: id, meta: v });
      }),
    );
    return { id };
  },

  async updateArea(user: AuthUser, areaId: string, v: { supervisorId?: string | null; wardIds?: string[] }) {
    const area = await AreaModel.find(db(), areaId);
    if (!area) throw notFound('Area not found');
    await assertCanManageUlb(db(), user, area.ulb_id);
    await db().transaction(async (trx) => {
      if (v.supervisorId !== undefined) {
        if (v.supervisorId) await assertSupervisorOfUlb(trx, v.supervisorId, area.ulb_id);
        await AreaModel.setSupervisor(trx, areaId, v.supervisorId || null);
      }
      if (v.wardIds) {
        await assertWardsBelongToUlb(trx, area.ulb_id, v.wardIds);
        await AreaModel.clearWards(trx, areaId);
        await AreaModel.assignWards(trx, areaId, area.ulb_id, v.wardIds);
      }
      await AuditModel.log(trx, { actorId: user.id, action: 'AREA_UPDATED', entity: 'area', entityId: areaId, meta: v });
    });
    return { id: areaId };
  },

  async updateComplaintType(user: AuthUser, id: string, v: { slaHours?: number; active?: boolean }) {
    if (!(await ComplaintTypeModel.find(db(), id))) throw notFound('Complaint type not found');
    await ComplaintTypeModel.update(db(), id, v);
    await AuditModel.log(db(), { actorId: user.id, action: 'COMPLAINT_TYPE_UPDATED', entity: 'complaint_type', entityId: id, meta: v });
    return { id };
  },
};
