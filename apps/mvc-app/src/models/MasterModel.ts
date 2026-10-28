import type { Db } from '@/db/sql';
import { one, query, run } from '@/db/sql';
import type { GeoJsonPolygon } from '@/lib/geo';
import type { UlbType } from '@/lib/enums';
import { isGeometryError } from '@/lib/errors';

const GEOM = `ST_GeomFromGeoJSON(?, 1, 4326)`;

export const DistrictModel = {
  list(d: Db) {
    return query(d, `SELECT id, lgd_code AS lgdCode, name, name_hi AS nameHi FROM districts WHERE active ORDER BY name`);
  },
  find(d: Db, id: string) {
    return one(d, `SELECT id, lgd_code, name FROM districts WHERE id = ?`, [id]);
  },
  findByLgd(d: Db, lgd: number) {
    return one<{ id: string }>(d, `SELECT id FROM districts WHERE lgd_code = ?`, [lgd]);
  },
  async insert(d: Db, v: { id: string; lgdCode: number; census2011Code?: number | null; name: string; nameHi?: string | null }) {
    await run(d, `INSERT INTO districts (id, lgd_code, census2011_code, name, name_hi) VALUES (?,?,?,?,?)`, [v.id, v.lgdCode, v.census2011Code ?? null, v.name, v.nameHi ?? null]);
  },
};

export const UlbModel = {
  list(d: Db, districtId: string) {
    return query(d, `SELECT id, lgd_code AS lgdCode, type, name, name_hi AS nameHi FROM ulbs WHERE district_id = ? AND active ORDER BY name`, [districtId]);
  },
  find(d: Db, id: string) {
    return one<{ id: string; district_id: string; lgd_code: number }>(d, `SELECT id, district_id, lgd_code FROM ulbs WHERE id = ?`, [id]);
  },
  findByLgd(d: Db, lgd: number) {
    return one<{ id: string }>(d, `SELECT id FROM ulbs WHERE lgd_code = ?`, [lgd]);
  },
  async insert(d: Db, v: { id: string; districtId: string; lgdCode: number; type: UlbType; name: string; nameHi?: string | null }) {
    await run(d, `INSERT INTO ulbs (id, district_id, lgd_code, type, name, name_hi) VALUES (?,?,?,?,?,?)`, [v.id, v.districtId, v.lgdCode, v.type, v.name, v.nameHi ?? null]);
  },
  async setBoundary(d: Db, ulbId: string, geo: GeoJsonPolygon) {
    await run(d, `INSERT INTO ulb_boundaries (ulb_id, geom) VALUES (?, ${GEOM}) ON DUPLICATE KEY UPDATE geom = VALUES(geom)`, [ulbId, JSON.stringify(geo)]);
  },
};

export interface WardOverlap {
  number: number;
  /** null: the database could not compute the overlap (edges almost, but not exactly, coincide). */
  overlapM2: number | null;
}

export const WardModel = {
  list(d: Db, ulbId: string) {
    return query(
      d,
      `SELECT w.id, w.number, w.name, w.area_id AS areaId, (b.ward_id IS NOT NULL) AS hasBoundary
         FROM wards w LEFT JOIN ward_boundaries b ON b.ward_id = w.id
        WHERE w.ulb_id = ? AND w.active ORDER BY w.number`,
      [ulbId],
    );
  },
  find(d: Db, id: string) {
    return one<{ id: string; ulb_id: string; number: number }>(d, `SELECT id, ulb_id, number FROM wards WHERE id = ?`, [id]);
  },
  findByNumber(d: Db, ulbId: string, number: number) {
    return one<{ id: string }>(d, `SELECT id FROM wards WHERE ulb_id = ? AND number = ?`, [ulbId, number]);
  },
  async insert(d: Db, v: { id: string; ulbId: string; number: number; name?: string | null }) {
    await run(d, `INSERT INTO wards (id, ulb_id, number, name) VALUES (?,?,?,?)`, [v.id, v.ulbId, v.number, v.name ?? null]);
  },
  async update(d: Db, id: string, v: { name?: string; active?: boolean }) {
    if (v.name !== undefined) await run(d, `UPDATE wards SET name = ? WHERE id = ?`, [v.name, id]);
    if (v.active !== undefined) await run(d, `UPDATE wards SET active = ? WHERE id = ?`, [v.active ? 1 : 0, id]);
  },

  /** True when MySQL considers the polygon valid (closed rings, no self-intersection). */
  async isValidGeometry(d: Db, geo: GeoJsonPolygon): Promise<boolean> {
    const r = await one<{ v: number | null }>(d, `SELECT ST_IsValid(${GEOM}) AS v`, [JSON.stringify(geo)]);
    return !!r?.v;
  },
  async setBoundary(d: Db, wardId: string, geo: GeoJsonPolygon) {
    await run(d, `INSERT INTO ward_boundaries (ward_id, geom) VALUES (?, ${GEOM}) ON DUPLICATE KEY UPDATE geom = VALUES(geom)`, [wardId, JSON.stringify(geo)]);
  },

  /** Ward boundaries of a ULB as GeoJSON features (for maps). */
  async boundaries(d: Db, ulbId: string) {
    const rows = await query<{ id: string; number: number; name: string | null; area_id: string | null; geometry: string }>(
      d,
      `SELECT w.id, w.number, w.name, w.area_id, ST_AsGeoJSON(b.geom, 6) AS geometry
         FROM wards w JOIN ward_boundaries b ON b.ward_id = w.id WHERE w.ulb_id = ? ORDER BY w.number`,
      [ulbId],
    );
    return rows.map((r) => ({
      type: 'Feature' as const,
      geometry: typeof r.geometry === 'string' ? JSON.parse(r.geometry) : r.geometry,
      properties: { id: r.id, number: r.number, name: r.name, areaId: r.area_id },
    }));
  },

  /** The ward containing a GPS point (lowest id wins if legacy data overlaps, so the answer never flips). */
  locate(d: Db, lat: number, lng: number) {
    return one(
      d,
      `SELECT w.id AS wardId, w.number AS wardNumber, w.name AS wardName, u.id AS ulbId, u.name AS ulbName, u.type AS ulbType,
              dd.id AS districtId, dd.name AS districtName, w.area_id AS areaId, u.district_id AS districtIdRaw
         FROM ward_boundaries b
         JOIN wards w ON w.id = b.ward_id AND w.active
         JOIN ulbs u ON u.id = w.ulb_id AND u.active
         JOIN districts dd ON dd.id = u.district_id
        WHERE ST_Contains(b.geom, ST_PointFromText(CONCAT('POINT(', ?, ' ', ?, ')'), 4326, 'axis-order=long-lat'))
        ORDER BY w.id LIMIT 1`,
      [lng, lat],
    );
  },

  /**
   * Active wards of the same ULB that cover more than `toleranceM2` of this ward.
   * MySQL returns a geographic intersection as a collection of parts (stray points, lines and the
   * polygons), so the area is summed over the polygon parts only. Done here, not in a stored function:
   * MySQL refuses to create functions without SUPER when binary logging is on.
   *
   * Known limit (measured): when two edges differ by less than about 10 cm the geodesic intersection is not
   * reliable (MySQL raises an error or returns a whole-ward area), so such a pair is reported as overlapping
   * with an unknown area and the upload is refused. Edges that coincide exactly (shared vertices) are fine.
   */
  async overlaps(d: Db, wardId: string, toleranceM2: number): Promise<WardOverlap[]> {
    const candidates = await query<{ id: string; number: number }>(
      d,
      `SELECT o.id, o.number
         FROM wards w
         JOIN ward_boundaries wb ON wb.ward_id = w.id
         JOIN wards o ON o.ulb_id = w.ulb_id AND o.id <> w.id AND o.active
         JOIN ward_boundaries ob ON ob.ward_id = o.id
        WHERE w.id = ? AND w.active AND ST_Intersects(wb.geom, ob.geom)`,
      [wardId],
    );
    const out: WardOverlap[] = [];
    for (const c of candidates) {
      let total: number | null;
      try {
        total = await WardModel.intersectionArea(d, wardId, c.id);
      } catch (err) {
        if (!isGeometryError(err)) throw err;
        total = null;
      }
      if (total === null || total > toleranceM2) out.push({ number: c.number, overlapM2: total === null ? null : Math.round(total) });
    }
    return out.sort((a, b) => (b.overlapM2 ?? Infinity) - (a.overlapM2 ?? Infinity) || a.number - b.number).slice(0, 5);
  },

  /** Geodesic area in m² shared by two ward boundaries (polygon parts of the intersection only). */
  async intersectionArea(d: Db, wardId: string, otherId: string): Promise<number> {
    const r = await one<{ gj: unknown }>(
      d,
      `SELECT ST_AsGeoJSON(ST_Intersection(a.geom, b.geom)) AS gj FROM ward_boundaries a, ward_boundaries b WHERE a.ward_id = ? AND b.ward_id = ?`,
      [wardId, otherId],
    );
    if (!r?.gj) return 0;
    const geo = (typeof r.gj === 'string' ? JSON.parse(r.gj) : r.gj) as { type: string; geometries?: { type: string }[] };
    const parts = geo.type === 'GeometryCollection' ? (geo.geometries ?? []) : [geo];
    let total = 0;
    for (const p of parts) {
      if (p.type !== 'Polygon' && p.type !== 'MultiPolygon') continue;
      const a = await one<{ a: number }>(d, `SELECT ST_Area(${GEOM}) AS a`, [JSON.stringify(p)]);
      total += a?.a ?? 0;
    }
    return total;
  },

  /** Serialises boundary changes of one ULB, so two overlapping uploads cannot both pass the overlap check. */
  async lockUlb(d: Db, ulbId: string) {
    await query(d, `SELECT id FROM ulbs WHERE id = ? FOR UPDATE`, [ulbId]);
  },
};

export const AreaModel = {
  async listWithWards(d: Db, ulbId: string) {
    const areas = await query<{ id: string; name: string; supervisorId: string | null; supervisorName: string | null }>(
      d,
      `SELECT a.id, a.name, a.supervisor_id AS supervisorId, s.name AS supervisorName
         FROM areas a LEFT JOIN users s ON s.id = a.supervisor_id WHERE a.ulb_id = ? ORDER BY a.name`,
      [ulbId],
    );
    const wards = await query<{ id: string; area_id: string }>(d, `SELECT id, area_id FROM wards WHERE ulb_id = ? AND area_id IS NOT NULL ORDER BY number`, [ulbId]);
    return areas.map((a) => ({ ...a, wardIds: wards.filter((w) => w.area_id === a.id).map((w) => w.id) }));
  },
  find(d: Db, id: string) {
    return one<{ id: string; ulb_id: string }>(d, `SELECT id, ulb_id FROM areas WHERE id = ?`, [id]);
  },
  findByName(d: Db, ulbId: string, name: string) {
    return one<{ id: string }>(d, `SELECT id FROM areas WHERE ulb_id = ? AND name = ?`, [ulbId, name]);
  },
  async insert(d: Db, v: { id: string; ulbId: string; name: string; supervisorId?: string | null }) {
    await run(d, `INSERT INTO areas (id, ulb_id, name, supervisor_id) VALUES (?,?,?,?)`, [v.id, v.ulbId, v.name, v.supervisorId ?? null]);
  },
  async setSupervisor(d: Db, id: string, supervisorId: string | null) {
    await run(d, `UPDATE areas SET supervisor_id = ? WHERE id = ?`, [supervisorId, id]);
  },
  async clearWards(d: Db, areaId: string) {
    await run(d, `UPDATE wards SET area_id = NULL WHERE area_id = ?`, [areaId]);
  },
  /** How many of these wards exist in the ULB (the service compares it with what was asked for). */
  async countWardsInUlb(d: Db, ulbId: string, wardIds: string[]): Promise<number> {
    if (!wardIds.length) return 0;
    const r = await one<{ n: number }>(d, `SELECT COUNT(*) AS n FROM wards WHERE id IN (?) AND ulb_id = ?`, [wardIds, ulbId]);
    return Number(r?.n ?? 0);
  },
  async assignWards(d: Db, areaId: string, ulbId: string, wardIds: string[]): Promise<void> {
    if (wardIds.length) await run(d, `UPDATE wards SET area_id = ? WHERE id IN (?) AND ulb_id = ?`, [areaId, wardIds, ulbId]);
  },
  async isSupervisorOf(d: Db, supervisorId: string, ulbId: string): Promise<boolean> {
    return !!(await one(d, `SELECT 1 AS x FROM users WHERE id = ? AND role = 'SUPERVISOR' AND ulb_id = ? AND status <> 'DISABLED'`, [supervisorId, ulbId]));
  },
};

export const ComplaintTypeModel = {
  list(d: Db, includeInactive: boolean) {
    return query(
      d,
      `SELECT id, code, name_en AS nameEn, name_hi AS nameHi, sla_hours AS slaHours, active
         FROM complaint_types ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, name_en`,
    );
  },
  find(d: Db, id: string) {
    return one<{ id: string; sla_hours: number; active: boolean }>(d, `SELECT id, sla_hours, active FROM complaint_types WHERE id = ?`, [id]);
  },
  async update(d: Db, id: string, v: { slaHours?: number; active?: boolean }): Promise<void> {
    await run(d, `UPDATE complaint_types SET sla_hours = COALESCE(?, sla_hours), active = COALESCE(?, active) WHERE id = ?`, [v.slaHours ?? null, v.active === undefined ? null : v.active ? 1 : 0, id]);
  },
};
