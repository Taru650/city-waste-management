import type { Knex } from 'knex';
import { ID, NOW, TABLE_OPTIONS, TS } from '../ddl';

/**
 * Jurisdiction masters: district > ULB (urban local body) > ward, areas (groups of wards served by
 * one supervisor), and the complaint types with their SLA hours. LGD = Local Government Directory codes.
 * Boundaries live in their own tables so each can carry a spatial index (MySQL needs NOT NULL for that).
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS districts (
      id ${ID} NOT NULL DEFAULT (UUID()),
      lgd_code int NOT NULL,
      census2011_code int NULL,
      name varchar(100) NOT NULL,
      name_hi varchar(100) NULL,
      active tinyint(1) NOT NULL DEFAULT 1,
      created_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      UNIQUE KEY districts_lgd_uq (lgd_code),
      CONSTRAINT districts_lgd_chk CHECK (lgd_code BETWEEN 1 AND 9999)
    ) ${TABLE_OPTIONS}`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ulbs (
      id ${ID} NOT NULL DEFAULT (UUID()),
      district_id ${ID} NOT NULL,
      lgd_code int NOT NULL,
      type enum('NAGAR_NIGAM','NAGAR_PARISHAD','NAGAR_PANCHAYAT') NOT NULL,
      name varchar(150) NOT NULL,
      name_hi varchar(150) NULL,
      active tinyint(1) NOT NULL DEFAULT 1,
      created_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      UNIQUE KEY ulbs_lgd_uq (lgd_code),
      KEY ulbs_district_idx (district_id),
      CONSTRAINT ulbs_district_fk FOREIGN KEY (district_id) REFERENCES districts (id),
      CONSTRAINT ulbs_lgd_chk CHECK (lgd_code BETWEEN 1 AND 999999)
    ) ${TABLE_OPTIONS}`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ulb_boundaries (
      ulb_id ${ID} NOT NULL,
      geom geometry SRID 4326 NOT NULL,
      PRIMARY KEY (ulb_id),
      SPATIAL KEY ulb_boundaries_gix (geom),
      CONSTRAINT ulb_boundaries_fk FOREIGN KEY (ulb_id) REFERENCES ulbs (id) ON DELETE CASCADE
    ) ${TABLE_OPTIONS}`);
  // areas.supervisor_id gets its foreign key to users in the next migration (users does not exist yet).
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS areas (
      id ${ID} NOT NULL DEFAULT (UUID()),
      ulb_id ${ID} NOT NULL,
      name varchar(100) NOT NULL,
      supervisor_id ${ID} NULL,
      created_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      UNIQUE KEY areas_ulb_name_uq (ulb_id, name),
      KEY areas_supervisor_idx (supervisor_id),
      CONSTRAINT areas_ulb_fk FOREIGN KEY (ulb_id) REFERENCES ulbs (id)
    ) ${TABLE_OPTIONS}`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS wards (
      id ${ID} NOT NULL DEFAULT (UUID()),
      ulb_id ${ID} NOT NULL,
      number int NOT NULL,
      name varchar(100) NULL,
      area_id ${ID} NULL,
      active tinyint(1) NOT NULL DEFAULT 1,
      created_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      UNIQUE KEY wards_ulb_number_uq (ulb_id, number),
      KEY wards_area_idx (area_id),
      CONSTRAINT wards_ulb_fk FOREIGN KEY (ulb_id) REFERENCES ulbs (id),
      CONSTRAINT wards_area_fk FOREIGN KEY (area_id) REFERENCES areas (id),
      CONSTRAINT wards_number_chk CHECK (number > 0)
    ) ${TABLE_OPTIONS}`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ward_boundaries (
      ward_id ${ID} NOT NULL,
      geom geometry SRID 4326 NOT NULL,
      PRIMARY KEY (ward_id),
      SPATIAL KEY ward_boundaries_gix (geom),
      CONSTRAINT ward_boundaries_fk FOREIGN KEY (ward_id) REFERENCES wards (id) ON DELETE CASCADE
    ) ${TABLE_OPTIONS}`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS complaint_types (
      id ${ID} NOT NULL DEFAULT (UUID()),
      code varchar(40) NOT NULL,
      name_en varchar(100) NOT NULL,
      name_hi varchar(100) NOT NULL,
      sla_hours int NOT NULL,
      sort_order int NOT NULL DEFAULT 0,
      active tinyint(1) NOT NULL DEFAULT 1,
      PRIMARY KEY (id),
      UNIQUE KEY complaint_types_code_uq (code),
      CONSTRAINT complaint_types_sla_chk CHECK (sla_hours > 0)
    ) ${TABLE_OPTIONS}`);
  // Reference data every installation needs (kept in the migration so a fresh database is usable).
  await knex.raw(`
    INSERT IGNORE INTO complaint_types (code, name_en, name_hi, sla_hours, sort_order) VALUES
      ('GARBAGE_HEAP',    'Garbage heap / kachra',  'कचरे का ढेर',           24, 1),
      ('WATER_LOGGING',   'Water logging',          'जल भराव',               24, 2),
      ('DRAIN_BLOCKAGE',  'Drain / nala blockage',  'नाली / नाला जाम',        48, 3),
      ('DEAD_ANIMAL',     'Dead animal',            'मृत पशु',                12, 4),
      ('PUBLIC_TOILET',   'Public toilet unclean',  'सार्वजनिक शौचालय गंदा',   24, 5),
      ('GARBAGE_BURNING', 'Burning of garbage',     'कचरा जलाना',             12, 6),
      ('SWEEPING',        'Road sweeping not done', 'सड़क की सफाई नहीं हुई',    24, 7),
      ('OTHER',           'Other',                  'अन्य',                   72, 99)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['complaint_types', 'ward_boundaries', 'wards', 'areas', 'ulb_boundaries', 'ulbs', 'districts']) {
    await knex.raw(`DROP TABLE IF EXISTS ${t}`);
  }
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
}
