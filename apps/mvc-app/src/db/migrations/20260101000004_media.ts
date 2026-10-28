import type { Knex } from 'knex';
import { ID, NOW, TABLE_OPTIONS, TS } from '../ddl';

/**
 * Camera-only evidence. Each app install registers a signing key (devices); every photo or video
 * carries a signed capture manifest (time, GPS, checksum). One signed capture can be used once.
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS devices (
      id ${ID} NOT NULL DEFAULT (UUID()),
      user_id ${ID} NOT NULL,
      public_key text NOT NULL,
      key_fingerprint char(64) NOT NULL,
      platform varchar(20) NOT NULL,
      app_version varchar(30) NULL,
      integrity_verdict varchar(30) NOT NULL DEFAULT 'UNVERIFIED',
      integrity_checked_at ${TS} NULL,
      created_at ${TS} NOT NULL ${NOW},
      last_used_at ${TS} NULL,
      revoked_at ${TS} NULL,
      PRIMARY KEY (id),
      UNIQUE KEY devices_fingerprint_uq (key_fingerprint),
      KEY devices_user_idx (user_id, revoked_at),
      CONSTRAINT devices_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ${TABLE_OPTIONS}`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS complaint_media (
      id ${ID} NOT NULL DEFAULT (UUID()),
      owner_id ${ID} NOT NULL,
      device_id ${ID} NOT NULL,
      complaint_id ${ID} NULL,
      stage enum('COMPLAINT','WORK_START','RESOLUTION') NULL,
      kind enum('PHOTO','VIDEO') NOT NULL,
      status enum('PENDING_UPLOAD','PROCESSING','READY','REJECTED') NOT NULL,
      content_type varchar(40) NOT NULL,
      declared_bytes int NOT NULL,
      declared_sha256 char(64) NOT NULL,
      staging_key varchar(300) NULL,
      object_key varchar(300) NULL,
      thumb_key varchar(300) NULL,
      stored_content_type varchar(40) NULL,
      bytes_stored int NULL,
      width int NULL,
      height int NULL,
      duration_s float NULL,
      captured_at ${TS} NULL,
      location point SRID 4326 NULL,
      gps_accuracy_m float NULL,
      manifest json NULL,
      signature text NULL,
      scan_status varchar(20) NULL,
      distance_m float NULL,
      outside_geofence tinyint(1) NULL,
      reject_reason varchar(200) NULL,
      created_at ${TS} NOT NULL ${NOW},
      confirmed_at ${TS} NULL,
      processed_at ${TS} NULL,
      attached_at ${TS} NULL,
      -- A signed capture can only be used once: this column is the checksum while the media is live, else NULL.
      live_sha256 char(64) GENERATED ALWAYS AS (IF(status IN ('PROCESSING','READY'), declared_sha256, NULL)) STORED,
      PRIMARY KEY (id),
      UNIQUE KEY complaint_media_live_sha_uq (live_sha256),
      KEY complaint_media_complaint_idx (complaint_id, stage),
      KEY complaint_media_owner_idx (owner_id, status, created_at),
      CONSTRAINT complaint_media_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id),
      CONSTRAINT complaint_media_device_fk FOREIGN KEY (device_id) REFERENCES devices (id),
      CONSTRAINT complaint_media_complaint_fk FOREIGN KEY (complaint_id) REFERENCES complaints (id),
      CONSTRAINT complaint_media_bytes_chk CHECK (declared_bytes > 0),
      CONSTRAINT complaint_media_attach_chk CHECK ((complaint_id IS NULL) = (stage IS NULL))
    ) ${TABLE_OPTIONS}`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['complaint_media', 'devices']) await knex.raw(`DROP TABLE IF EXISTS ${t}`);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
}
