import type { Knex } from 'knex';
import { ID, NOW, TABLE_OPTIONS, TS } from '../ddl';

/**
 * Event zones, complaints, their append-only history, feedback and the audit log.
 * complaint_no = {district LGD:4}{ULB LGD:6}{YY:2}{sequence:6}, the sequence kept per ULB and year.
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // Festival / mela / monsoon zones: a polygon and a date range with their own supervisor and deadline.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS event_zones (
      id ${ID} NOT NULL DEFAULT (UUID()),
      ulb_id ${ID} NOT NULL,
      name varchar(120) NOT NULL,
      geom geometry SRID 4326 NOT NULL,
      starts_at ${TS} NOT NULL,
      ends_at ${TS} NOT NULL,
      supervisor_id ${ID} NULL,
      sla_hours smallint NULL,
      active tinyint(1) NOT NULL DEFAULT 1,
      handed_over_at ${TS} NULL,
      created_by ${ID} NOT NULL,
      created_at ${TS} NOT NULL ${NOW},
      updated_at ${TS} NOT NULL ${NOW} ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      SPATIAL KEY event_zones_gix (geom),
      KEY event_zones_window_idx (ulb_id, active, starts_at, ends_at),
      CONSTRAINT event_zones_ulb_fk FOREIGN KEY (ulb_id) REFERENCES ulbs (id),
      CONSTRAINT event_zones_supervisor_fk FOREIGN KEY (supervisor_id) REFERENCES users (id),
      CONSTRAINT event_zones_creator_fk FOREIGN KEY (created_by) REFERENCES users (id),
      CONSTRAINT event_zones_sla_chk CHECK (sla_hours IS NULL OR sla_hours BETWEEN 1 AND 720),
      CONSTRAINT event_zones_window_chk CHECK (ends_at > starts_at)
    ) ${TABLE_OPTIONS}`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS complaint_seq (
      ulb_id ${ID} NOT NULL,
      year int NOT NULL,
      last_no int NOT NULL DEFAULT 0,
      PRIMARY KEY (ulb_id, year),
      CONSTRAINT complaint_seq_ulb_fk FOREIGN KEY (ulb_id) REFERENCES ulbs (id)
    ) ${TABLE_OPTIONS}`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS complaints (
      id ${ID} NOT NULL DEFAULT (UUID()),
      complaint_no char(18) CHARACTER SET ascii NOT NULL,
      citizen_id ${ID} NOT NULL,
      district_id ${ID} NOT NULL,
      ulb_id ${ID} NOT NULL,
      ward_id ${ID} NOT NULL,
      area_id ${ID} NULL,
      ward_source enum('GPS','MANUAL') NOT NULL,
      ward_mismatch tinyint(1) NOT NULL DEFAULT 0,
      type_id ${ID} NOT NULL,
      landmark varchar(50) NULL,
      description varchar(250) NOT NULL,
      location point SRID 4326 NOT NULL,
      lat double GENERATED ALWAYS AS (ST_Latitude(location)) STORED,
      lng double GENERATED ALWAYS AS (ST_Longitude(location)) STORED,
      gps_accuracy_m float NULL,
      status enum('PENDING','ASSIGNED','WORK_IN_PROGRESS','RESOLVED','REJECTED','DUPLICATE','REOPENED','CLOSED') NOT NULL,
      supervisor_id ${ID} NULL,
      worker_id ${ID} NULL,
      duplicate_of ${ID} NULL,
      event_zone_id ${ID} NULL,
      reopen_count int NOT NULL DEFAULT 0,
      escalated tinyint(1) NOT NULL DEFAULT 0,
      sla_due_at ${TS} NOT NULL,
      sla_breached_at ${TS} NULL,
      escalated_at ${TS} NULL,
      assigned_at ${TS} NULL,
      resolved_at ${TS} NULL,
      closed_at ${TS} NULL,
      resolution_remark varchar(500) NULL,
      created_at ${TS} NOT NULL ${NOW},
      updated_at ${TS} NOT NULL ${NOW} ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY complaints_no_uq (complaint_no),
      SPATIAL KEY complaints_location_gix (location),
      KEY complaints_ulb_status_idx (ulb_id, status, created_at),
      KEY complaints_district_idx (district_id, created_at),
      KEY complaints_supervisor_idx (supervisor_id, status),
      KEY complaints_worker_idx (worker_id, status),
      KEY complaints_citizen_idx (citizen_id, created_at),
      KEY complaints_area_idx (area_id, status),
      KEY complaints_open_sla_idx (status, sla_due_at),
      KEY complaints_event_zone_idx (event_zone_id),
      KEY complaints_duplicate_search_idx (ulb_id, type_id, lat),
      CONSTRAINT complaints_citizen_fk FOREIGN KEY (citizen_id) REFERENCES users (id),
      CONSTRAINT complaints_district_fk FOREIGN KEY (district_id) REFERENCES districts (id),
      CONSTRAINT complaints_ulb_fk FOREIGN KEY (ulb_id) REFERENCES ulbs (id),
      CONSTRAINT complaints_ward_fk FOREIGN KEY (ward_id) REFERENCES wards (id),
      CONSTRAINT complaints_area_fk FOREIGN KEY (area_id) REFERENCES areas (id),
      CONSTRAINT complaints_type_fk FOREIGN KEY (type_id) REFERENCES complaint_types (id),
      CONSTRAINT complaints_supervisor_fk FOREIGN KEY (supervisor_id) REFERENCES users (id),
      CONSTRAINT complaints_worker_fk FOREIGN KEY (worker_id) REFERENCES users (id),
      CONSTRAINT complaints_duplicate_fk FOREIGN KEY (duplicate_of) REFERENCES complaints (id),
      CONSTRAINT complaints_zone_fk FOREIGN KEY (event_zone_id) REFERENCES event_zones (id)
    ) ${TABLE_OPTIONS}`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS complaint_events (
      id bigint unsigned NOT NULL AUTO_INCREMENT,
      complaint_id ${ID} NOT NULL,
      action varchar(30) NOT NULL,
      from_status varchar(20) NULL,
      to_status varchar(20) NOT NULL,
      actor_id ${ID} NULL,
      remark varchar(500) NULL,
      meta json NULL,
      created_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      KEY complaint_events_complaint_idx (complaint_id, created_at),
      KEY complaint_events_created_idx (created_at),
      CONSTRAINT complaint_events_complaint_fk FOREIGN KEY (complaint_id) REFERENCES complaints (id),
      CONSTRAINT complaint_events_actor_fk FOREIGN KEY (actor_id) REFERENCES users (id)
    ) ${TABLE_OPTIONS}`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS feedback (
      id ${ID} NOT NULL DEFAULT (UUID()),
      complaint_id ${ID} NOT NULL,
      citizen_id ${ID} NOT NULL,
      rating tinyint NOT NULL,
      remark varchar(250) NULL,
      reopen_requested tinyint(1) NOT NULL DEFAULT 0,
      created_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      KEY feedback_complaint_idx (complaint_id),
      CONSTRAINT feedback_complaint_fk FOREIGN KEY (complaint_id) REFERENCES complaints (id),
      CONSTRAINT feedback_citizen_fk FOREIGN KEY (citizen_id) REFERENCES users (id),
      CONSTRAINT feedback_rating_chk CHECK (rating BETWEEN 1 AND 5)
    ) ${TABLE_OPTIONS}`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id bigint unsigned NOT NULL AUTO_INCREMENT,
      actor_id ${ID} NULL,
      action varchar(60) NOT NULL,
      entity varchar(40) NULL,
      entity_id varchar(64) NULL,
      ip varchar(64) NULL,
      meta json NULL,
      created_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      KEY audit_logs_actor_idx (actor_id, created_at),
      KEY audit_logs_action_idx (action, created_at)
    ) ${TABLE_OPTIONS}`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['audit_logs', 'feedback', 'complaint_events', 'complaints', 'complaint_seq', 'event_zones']) {
    await knex.raw(`DROP TABLE IF EXISTS ${t}`);
  }
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
}
