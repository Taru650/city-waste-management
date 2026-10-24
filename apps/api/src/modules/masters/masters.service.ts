import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../../common/auth-user';
import { Role } from '../../common/enums';
import { GeoJsonPolygon } from '../../common/geojson.validator';
import { mutateReturning } from '../../common/db';
import { assertCanManageUlb } from '../../common/scope';
import { AuditService } from '../audit/audit.service';
import {
  CreateAreaDto, CreateDistrictDto, CreateUlbDto, CreateWardDto, UpdateAreaDto, UpdateComplaintTypeDto, UpdateWardDto,
} from './dto/masters.dto';

/** PostgreSQL unique_violation */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class MastersService {
  constructor(private readonly ds: DataSource, private readonly audit: AuditService) {}

  // ---- Public lookups (registration and complaint dropdowns) ----

  listDistricts() {
    return this.ds.query(
      `SELECT id, lgd_code AS "lgdCode", name, name_hi AS "nameHi" FROM districts WHERE active ORDER BY name`,
    );
  }

  listUlbs(districtId: string) {
    return this.ds.query(
      `SELECT id, lgd_code AS "lgdCode", type, name, name_hi AS "nameHi"
         FROM ulbs WHERE district_id = $1 AND active ORDER BY name`,
      [districtId],
    );
  }

  listWards(ulbId: string) {
    return this.ds.query(
      `SELECT id, number, name, area_id AS "areaId", geom IS NOT NULL AS "hasBoundary"
         FROM wards WHERE ulb_id = $1 AND active ORDER BY number`,
      [ulbId],
    );
  }

  listComplaintTypes(includeInactive = false) {
    return this.ds.query(
      `SELECT id, code, name_en AS "nameEn", name_hi AS "nameHi", sla_hours AS "slaHours", active
         FROM complaint_types ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, name_en`,
    );
  }

  /** Ward boundaries of a ULB as a GeoJSON FeatureCollection (maps in the portal). */
  async wardBoundaries(user: AuthUser, ulbId: string) {
    if (user.role !== Role.SUPERVISOR) await assertCanManageUlb(this.ds, user, ulbId);
    else if (user.ulbId !== ulbId) throw new ForbiddenException('Outside your jurisdiction');
    const rows = await this.ds.query(
      `SELECT id, number, name, area_id, ST_AsGeoJSON(geom, 6)::json AS geometry
         FROM wards WHERE ulb_id = $1 AND geom IS NOT NULL ORDER BY number`,
      [ulbId],
    );
    return {
      type: 'FeatureCollection',
      features: rows.map((r: { id: string; number: number; name: string | null; area_id: string | null; geometry: object }) => ({
        type: 'Feature', geometry: r.geometry, properties: { id: r.id, number: r.number, name: r.name, areaId: r.area_id },
      })),
    };
  }

  /** Reverse-geocode a GPS point to ward → ULB → district using ward polygons. */
  async locate(lat: number, lng: number) {
    const [row] = await this.ds.query(
      `SELECT w.id AS "wardId", w.number AS "wardNumber", w.name AS "wardName",
              u.id AS "ulbId", u.name AS "ulbName", u.type AS "ulbType",
              d.id AS "districtId", d.name AS "districtName"
         FROM wards w JOIN ulbs u ON u.id = w.ulb_id JOIN districts d ON d.id = u.district_id
        WHERE w.active AND u.active AND ST_Contains(w.geom, ST_SetSRID(ST_MakePoint($2, $1), 4326))
        LIMIT 1`,
      [lat, lng],
    );
    if (!row) throw new NotFoundException('No ward boundary covers this location; choose the ward manually');
    return row;
  }

  // ---- Administration ----

  async createDistrict(user: AuthUser, dto: CreateDistrictDto) {
    const [row] = await this.unique(() =>
      this.ds.query(
        `INSERT INTO districts (lgd_code, census2011_code, name, name_hi) VALUES ($1,$2,$3,$4) RETURNING id`,
        [dto.lgdCode, dto.census2011Code ?? null, dto.name, dto.nameHi ?? null],
      ),
    );
    await this.audit.log({ actorId: user.id, action: 'DISTRICT_CREATED', entity: 'district', entityId: row.id, meta: dto });
    return row;
  }

  async createUlb(user: AuthUser, dto: CreateUlbDto) {
    if (user.role === Role.DISTRICT_ADMIN && dto.districtId !== user.districtId) {
      throw new ForbiddenException('Outside your jurisdiction');
    }
    const [district] = await this.ds.query(`SELECT id FROM districts WHERE id = $1`, [dto.districtId]);
    if (!district) throw new NotFoundException('District not found');
    return this.ds.transaction(async (m) => {
      const [row] = await this.unique(() =>
        m.query(
          `INSERT INTO ulbs (district_id, lgd_code, type, name, name_hi) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [dto.districtId, dto.lgdCode, dto.type, dto.name, dto.nameHi ?? null],
        ),
      );
      if (dto.boundary) await this.setGeom(m, 'ulbs', row.id, dto.boundary);
      await this.audit.log({ actorId: user.id, action: 'ULB_CREATED', entity: 'ulb', entityId: row.id, meta: { ...dto, boundary: !!dto.boundary } }, m);
      return row;
    });
  }

  async createWard(user: AuthUser, dto: CreateWardDto) {
    await assertCanManageUlb(this.ds, user, dto.ulbId);
    return this.ds.transaction(async (m) => {
      const [row] = await this.unique(() =>
        m.query(`INSERT INTO wards (ulb_id, number, name) VALUES ($1,$2,$3) RETURNING id`, [dto.ulbId, dto.number, dto.name ?? null]),
      );
      if (dto.boundary) await this.setGeom(m, 'wards', row.id, dto.boundary);
      await this.audit.log({ actorId: user.id, action: 'WARD_CREATED', entity: 'ward', entityId: row.id, meta: { ulbId: dto.ulbId, number: dto.number } }, m);
      return row;
    });
  }

  async updateWard(user: AuthUser, wardId: string, dto: UpdateWardDto) {
    const [ward] = await this.ds.query(`SELECT id, ulb_id FROM wards WHERE id = $1`, [wardId]);
    if (!ward) throw new NotFoundException('Ward not found');
    await assertCanManageUlb(this.ds, user, ward.ulb_id);
    await this.ds.transaction(async (m) => {
      if (dto.name !== undefined) await m.query(`UPDATE wards SET name = $2 WHERE id = $1`, [wardId, dto.name]);
      if (dto.active !== undefined) await m.query(`UPDATE wards SET active = $2 WHERE id = $1`, [wardId, dto.active]);
      if (dto.boundary) await this.setGeom(m, 'wards', wardId, dto.boundary);
      await this.audit.log({ actorId: user.id, action: 'WARD_UPDATED', entity: 'ward', entityId: wardId, meta: { ...dto, boundary: !!dto.boundary } }, m);
    });
    return { id: wardId };
  }

  async listAreas(user: AuthUser, ulbId: string) {
    await assertCanManageUlb(this.ds, user, ulbId);
    return this.ds.query(
      `SELECT a.id, a.name, a.supervisor_id AS "supervisorId", s.name AS "supervisorName",
              COALESCE(array_agg(w.id ORDER BY w.number) FILTER (WHERE w.id IS NOT NULL), '{}') AS "wardIds"
         FROM areas a
         LEFT JOIN users s ON s.id = a.supervisor_id
         LEFT JOIN wards w ON w.area_id = a.id
        WHERE a.ulb_id = $1
        GROUP BY a.id, s.name ORDER BY a.name`,
      [ulbId],
    );
  }

  async createArea(user: AuthUser, dto: CreateAreaDto) {
    await assertCanManageUlb(this.ds, user, dto.ulbId);
    return this.ds.transaction(async (m) => {
      if (dto.supervisorId) await this.assertSupervisorOfUlb(m, dto.supervisorId, dto.ulbId);
      const [row] = await this.unique(() =>
        m.query(`INSERT INTO areas (ulb_id, name, supervisor_id) VALUES ($1,$2,$3) RETURNING id`, [dto.ulbId, dto.name, dto.supervisorId ?? null]),
      );
      await this.assignWards(m, row.id, dto.ulbId, dto.wardIds);
      await this.audit.log({ actorId: user.id, action: 'AREA_CREATED', entity: 'area', entityId: row.id, meta: dto }, m);
      return row;
    });
  }

  async updateArea(user: AuthUser, areaId: string, dto: UpdateAreaDto) {
    const [area] = await this.ds.query(`SELECT id, ulb_id FROM areas WHERE id = $1`, [areaId]);
    if (!area) throw new NotFoundException('Area not found');
    await assertCanManageUlb(this.ds, user, area.ulb_id);
    await this.ds.transaction(async (m) => {
      if (dto.supervisorId !== undefined) {
        if (dto.supervisorId) await this.assertSupervisorOfUlb(m, dto.supervisorId, area.ulb_id);
        await m.query(`UPDATE areas SET supervisor_id = $2 WHERE id = $1`, [areaId, dto.supervisorId || null]);
      }
      if (dto.wardIds) {
        await m.query(`UPDATE wards SET area_id = NULL WHERE area_id = $1`, [areaId]);
        await this.assignWards(m, areaId, area.ulb_id, dto.wardIds);
      }
      await this.audit.log({ actorId: user.id, action: 'AREA_UPDATED', entity: 'area', entityId: areaId, meta: dto }, m);
    });
    return { id: areaId };
  }

  async updateComplaintType(user: AuthUser, id: string, dto: UpdateComplaintTypeDto) {
    const [row] = await mutateReturning(
      this.ds,
      `UPDATE complaint_types SET sla_hours = COALESCE($2, sla_hours), active = COALESCE($3, active)
        WHERE id = $1 RETURNING id`,
      [id, dto.slaHours ?? null, dto.active ?? null],
    );
    if (!row) throw new NotFoundException('Complaint type not found');
    await this.audit.log({ actorId: user.id, action: 'COMPLAINT_TYPE_UPDATED', entity: 'complaint_type', entityId: id, meta: dto });
    return row;
  }

  // ---- helpers ----

  private async setGeom(m: EntityManager, table: 'wards' | 'ulbs', id: string, geo: GeoJsonPolygon) {
    const [check] = await m.query(
      `SELECT ST_IsValid(g) AS valid FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) s`,
      [JSON.stringify(geo)],
    );
    if (!check.valid) throw new BadRequestException('Boundary polygon is not valid (self-intersecting or unclosed ring)');
    await m.query(`UPDATE ${table} SET geom = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)) WHERE id = $1`, [id, JSON.stringify(geo)]);
  }

  private async assignWards(m: EntityManager, areaId: string, ulbId: string, wardIds: string[]) {
    if (!wardIds.length) return;
    const rows = await mutateReturning(m, `UPDATE wards SET area_id = $1 WHERE id = ANY($2::uuid[]) AND ulb_id = $3 RETURNING id`, [areaId, wardIds, ulbId]);
    if (rows.length !== new Set(wardIds).size) throw new BadRequestException('All wards must belong to the same ULB');
  }

  private async assertSupervisorOfUlb(m: EntityManager, supervisorId: string, ulbId: string) {
    const [s] = await m.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'SUPERVISOR' AND ulb_id = $2 AND status <> 'DISABLED'`, [supervisorId, ulbId]);
    if (!s) throw new BadRequestException('Supervisor must be an active supervisor of this ULB');
  }

  private async unique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new ConflictException('Already exists');
      throw err;
    }
  }
}
