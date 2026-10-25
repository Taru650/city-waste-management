import { MigrationInterface, QueryRunner } from 'typeorm';

export class EventZones1761700000000 implements MigrationInterface {
  name = 'EventZones1761700000000';

  public async up(q: QueryRunner): Promise<void> {
    // Festivals, melas, monsoon hotspots: a polygon and a date range with its own supervisor and
    // a tighter deadline. Complaints filed inside an active zone route there.
    await q.query(`
      CREATE TABLE event_zones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ulb_id uuid NOT NULL REFERENCES ulbs(id),
        name varchar(120) NOT NULL,
        geom geometry(MultiPolygon, 4326) NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        supervisor_id uuid REFERENCES users(id),
        sla_hours smallint CHECK (sla_hours BETWEEN 1 AND 720),
        active boolean NOT NULL DEFAULT true,
        handed_over_at timestamptz,
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (ends_at > starts_at)
      )`);
    await q.query(`CREATE INDEX event_zones_geom_idx ON event_zones USING gist(geom)`);
    await q.query(`CREATE INDEX event_zones_window_idx ON event_zones(ulb_id, starts_at, ends_at) WHERE active`);
    await q.query(`ALTER TABLE complaints ADD COLUMN event_zone_id uuid REFERENCES event_zones(id)`);
    await q.query(`CREATE INDEX complaints_event_zone_idx ON complaints(event_zone_id) WHERE event_zone_id IS NOT NULL`);
    // Temporary staff for an event: sign-in stops after this moment.
    await q.query(`ALTER TABLE users ADD COLUMN access_expires_at timestamptz`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE users DROP COLUMN access_expires_at`);
    await q.query(`ALTER TABLE complaints DROP COLUMN event_zone_id`);
    await q.query(`DROP TABLE event_zones`);
  }
}
