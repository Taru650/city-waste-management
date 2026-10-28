import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../../common/auth-user';
import { mutateReturning } from '../../common/db';
import { Role } from '../../common/enums';
import { GeoJsonPolygon } from '../../common/geojson.validator';
import { assertCanManageUlb } from '../../common/scope';
import { AuditService } from '../audit/audit.service';
import { ComplaintAction } from '../complaints/state-machine';
import { NotificationsService } from '../notifications/notifications.service';
import { templates } from '../notifications/templates';
import { CreateEventZoneDto, ListEventZonesQuery, UpdateEventZoneDto } from './zones.dto';

/** Longest event (Kumbh-scale melas run ~2 months); longer needs are ward/area changes, not events. */
export const MAX_ZONE_DAYS = 92;
/** 100 km²: an event, not a city. */
export const MAX_ZONE_AREA_M2 = 100_000_000;
const OPEN = `('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`;

const COLUMNS = `z.id, z.ulb_id AS "ulbId", u.name AS "ulbName", z.name, ST_AsGeoJSON(z.geom, 6)::json AS boundary,
  z.starts_at AS "startsAt", z.ends_at AS "endsAt", z.supervisor_id AS "supervisorId", s.name AS "supervisorName",
  z.sla_hours AS "slaHours", z.active, z.handed_over_at AS "handedOverAt",
  (z.active AND now() BETWEEN z.starts_at AND z.ends_at) AS "current",
  round(ST_Area(z.geom::geography))::bigint AS "areaM2"`;
const FROM = `FROM event_zones z JOIN ulbs u ON u.id = z.ulb_id LEFT JOIN users s ON s.id = z.supervisor_id`;

/** Which zones a user may see: admins by jurisdiction, supervisors the zones they run. */
function zoneScope(user: AuthUser, params: unknown[]): string {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  switch (user.role) {
    case Role.WEB_ADMIN:
      return 'TRUE';
    case Role.DISTRICT_ADMIN:
      return `u.district_id = ${p(user.districtId)}`;
    case Role.SUB_ADMIN:
      return `z.ulb_id = ${p(user.ulbId)}`;
    case Role.SUPERVISOR:
      return `z.supervisor_id = ${p(user.id)}`;
    default:
      return 'FALSE';
  }
}

@Injectable()
export class ZonesService {
  constructor(private readonly ds: DataSource, private readonly audit: AuditService, private readonly notifications: NotificationsService) {}

  async list(user: AuthUser, q: ListEventZonesQuery) {
    const params: unknown[] = [];
    const where = [zoneScope(user, params)];
    if (q.ulbId) {
      params.push(q.ulbId);
      where.push(`z.ulb_id = $${params.length}`);
    }
    if (q.when === 'current') where.push(`z.active AND now() BETWEEN z.starts_at AND z.ends_at`);
    if (q.when === 'upcoming') where.push(`z.active AND z.starts_at > now()`);
    if (q.when === 'past') where.push(`(z.ends_at < now() OR NOT z.active)`);
    return this.ds.query(`SELECT ${COLUMNS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY z.starts_at DESC LIMIT 200`, params);
  }

  async get(user: AuthUser, id: string) {
    const params: unknown[] = [id];
    const [zone] = await this.ds.query(`SELECT ${COLUMNS} ${FROM} WHERE z.id = $1 AND ${zoneScope(user, params)}`, params);
    if (!zone) throw new NotFoundException('Event zone not found');
    const [stats] = await this.ds.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status IN ${OPEN})::int AS open,
              count(*) FILTER (WHERE status IN ${OPEN} AND sla_due_at < now())::int AS overdue,
              round((avg(extract(epoch FROM resolved_at - created_at)) FILTER (WHERE resolved_at IS NOT NULL) / 3600)::numeric, 1)::float AS "avgDisposalHours"
         FROM complaints WHERE event_zone_id = $1`,
      [id],
    );
    return { ...zone, stats };
  }

  async create(user: AuthUser, dto: CreateEventZoneDto) {
    const ulb = await assertCanManageUlb(this.ds, user, user.role === Role.SUB_ADMIN ? user.ulbId! : dto.ulbId);
    return this.ds.transaction(async (m) => {
      const values = { name: dto.name, boundary: dto.boundary, startsAt: new Date(dto.startsAt), endsAt: new Date(dto.endsAt), supervisorId: dto.supervisorId ?? null, slaHours: dto.slaHours ?? null };
      await this.validate(m, ulb.id, values, null);
      const [row] = await m.query(
        `INSERT INTO event_zones (ulb_id, name, geom, starts_at, ends_at, supervisor_id, sla_hours, created_by)
         VALUES ($1, $2, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)), $4, $5, $6, $7, $8) RETURNING id`,
        [ulb.id, values.name, JSON.stringify(values.boundary), values.startsAt, values.endsAt, values.supervisorId, values.slaHours, user.id],
      );
      await this.audit.log({ actorId: user.id, action: 'EVENT_ZONE_CREATED', entity: 'event_zone', entityId: row.id, meta: { ulbId: ulb.id, name: values.name } }, m);
      return { id: row.id };
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateEventZoneDto) {
    return this.ds.transaction(async (m) => {
      const [z] = await m.query(
        `SELECT id, ulb_id, name, ST_AsGeoJSON(geom)::json AS boundary, starts_at, ends_at, supervisor_id, sla_hours, active
           FROM event_zones WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!z) throw new NotFoundException('Event zone not found');
      await assertCanManageUlb(m, user, z.ulb_id);
      const values = {
        name: dto.name ?? z.name,
        boundary: (dto.boundary ?? z.boundary) as GeoJsonPolygon,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : (z.starts_at as Date),
        endsAt: dto.endsAt ? new Date(dto.endsAt) : (z.ends_at as Date),
        supervisorId: dto.supervisorId === undefined ? z.supervisor_id : dto.supervisorId,
        slaHours: dto.slaHours === undefined ? z.sla_hours : dto.slaHours,
      };
      const active = dto.active ?? z.active;
      if (active) await this.validate(m, z.ulb_id, values, id, { allowPastEnd: !dto.endsAt });
      await m.query(
        `UPDATE event_zones SET name = $2, geom = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)), starts_at = $4, ends_at = $5,
                supervisor_id = $6, sla_hours = $7, active = $8, updated_at = now(),
                -- re-opened or extended into the future: it will need a handover again when it ends
                handed_over_at = CASE WHEN $8 AND $5 > now() THEN NULL ELSE handed_over_at END
          WHERE id = $1`,
        [id, values.name, JSON.stringify(values.boundary), values.startsAt, values.endsAt, values.supervisorId, values.slaHours, active],
      );
      await this.audit.log({ actorId: user.id, action: active ? 'EVENT_ZONE_UPDATED' : 'EVENT_ZONE_CANCELLED', entity: 'event_zone', entityId: id, meta: { ...dto, boundary: undefined } }, m);
      return { id };
    });
  }

  /**
   * Zone that a new complaint at this point falls into, if any: active now, same ULB. Overlaps are
   * refused at creation, so at most one matches.
   */
  async zoneFor(m: EntityManager, ulbId: string, lat: number, lng: number) {
    const [z] = await m.query(
      `SELECT z.id, z.sla_hours,
              (SELECT s.id FROM users s WHERE s.id = z.supervisor_id AND s.status = 'ACTIVE'
                  AND (s.access_expires_at IS NULL OR s.access_expires_at > now())) AS supervisor_id
         FROM event_zones z
        WHERE z.active AND z.ulb_id = $1 AND now() BETWEEN z.starts_at AND z.ends_at
          AND ST_Contains(z.geom, ST_SetSRID(ST_MakePoint($3, $2), 4326))
        LIMIT 1`,
      [ulbId, lat, lng],
    );
    return z as { id: string; sla_hours: number | null; supervisor_id: string | null } | undefined;
  }

  /**
   * Ended or cancelled zones: open complaints still with the zone supervisor go back to the area
   * supervisor (or the Sub Admin queue), so nothing is stranded with a temporary account.
   */
  async handover(): Promise<number> {
    const zones = await this.ds.query(
      `SELECT id, name, supervisor_id, ulb_id FROM event_zones WHERE handed_over_at IS NULL AND (ends_at < now() OR NOT active) LIMIT 50`,
    );
    let moved = 0;
    for (const z of zones) {
      moved += await this.ds.transaction(async (m) => {
        const [locked] = await m.query(`SELECT 1 FROM event_zones WHERE id = $1 AND handed_over_at IS NULL FOR UPDATE SKIP LOCKED`, [z.id]);
        if (!locked) return 0;
        const rows = await mutateReturning<{ id: string; complaint_no: string; status: string; supervisor_id: string | null }>(
          m,
          `UPDATE complaints c
              SET supervisor_id = (SELECT a.supervisor_id FROM areas a JOIN users s ON s.id = a.supervisor_id AND s.status = 'ACTIVE'
                                    WHERE a.id = c.area_id),
                  updated_at = now()
            WHERE c.event_zone_id = $1 AND c.status IN ${OPEN} AND c.supervisor_id IS NOT DISTINCT FROM $2
            RETURNING c.id, c.complaint_no, c.status, c.supervisor_id`,
          [z.id, z.supervisor_id],
        );
        for (const c of rows) {
          await m.query(
            `INSERT INTO complaint_events (complaint_id, action, from_status, to_status, actor_id, remark, meta) VALUES ($1, $2, $3, $3, NULL, NULL, $4)`,
            [c.id, ComplaintAction.HANDOVER, c.status, { eventZoneId: z.id, from: z.supervisor_id, to: c.supervisor_id }],
          );
          const to = c.supervisor_id ? [c.supervisor_id] : await this.notifications.subAdminsOf(m, z.ulb_id);
          await this.notifications.notify(m, to, templates.handedOver(c.complaint_no, z.name), c.id);
        }
        await m.query(`UPDATE event_zones SET handed_over_at = now() WHERE id = $1`, [z.id]);
        return rows.length;
      });
    }
    if (moved) await this.notifications.kick();
    return moved;
  }

  private async validate(
    m: EntityManager, ulbId: string,
    v: { boundary: GeoJsonPolygon; startsAt: Date; endsAt: Date; supervisorId: string | null },
    selfId: string | null, opts: { allowPastEnd?: boolean } = {},
  ) {
    if (!(v.endsAt > v.startsAt)) throw new BadRequestException('endsAt must be after startsAt');
    if (!opts.allowPastEnd && v.endsAt <= new Date()) throw new BadRequestException('endsAt must be in the future');
    if (v.endsAt.getTime() - v.startsAt.getTime() > MAX_ZONE_DAYS * 86_400_000) throw new BadRequestException(`An event zone can last at most ${MAX_ZONE_DAYS} days`);
    const geo = JSON.stringify(v.boundary);
    const [g] = await m.query(
      `WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g)
       SELECT ST_IsValid(g.g) AS valid, ST_Area(g.g::geography) AS area,
              EXISTS (SELECT 1 FROM wards w WHERE w.ulb_id = $2 AND w.geom IS NOT NULL AND ST_Intersects(w.geom, g.g)) AS in_ulb
         FROM g`,
      [geo, ulbId],
    );
    if (!g.valid) throw new BadRequestException('Zone polygon is not valid (self-intersecting or unclosed ring)');
    if (Number(g.area) > MAX_ZONE_AREA_M2) throw new BadRequestException('Zone is larger than 100 km²');
    if (!g.in_ulb) throw new BadRequestException('Zone must overlap the wards of its ULB');
    // Two active zones covering the same place at the same time would make routing ambiguous.
    const [clash] = await m.query(
      `SELECT name FROM event_zones
        WHERE active AND ulb_id = $1 AND ($2::uuid IS NULL OR id <> $2) AND starts_at < $4 AND ends_at > $3
          AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326))
        LIMIT 1`,
      [ulbId, selfId, v.startsAt, v.endsAt, geo],
    );
    if (clash) throw new BadRequestException(`Overlaps event zone "${clash.name}" at the same time`);
    if (v.supervisorId) {
      const [s] = await m.query(
        `SELECT access_expires_at FROM users WHERE id = $1 AND role = 'SUPERVISOR' AND ulb_id = $2 AND status = 'ACTIVE'`,
        [v.supervisorId, ulbId],
      );
      if (!s) throw new BadRequestException('Supervisor must be an active supervisor of this ULB');
      if (s.access_expires_at && new Date(s.access_expires_at) < v.endsAt) {
        throw new BadRequestException("The supervisor's access ends before the zone does");
      }
    }
  }
}
