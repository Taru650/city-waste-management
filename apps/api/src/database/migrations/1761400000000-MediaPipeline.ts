import { MigrationInterface, QueryRunner } from 'typeorm';

export class MediaPipeline1761400000000 implements MigrationInterface {
  name = 'MediaPipeline1761400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE media_kind AS ENUM ('PHOTO','VIDEO')`);
    await q.query(`CREATE TYPE media_status AS ENUM ('PENDING_UPLOAD','PROCESSING','READY','REJECTED')`);
    await q.query(`CREATE TYPE media_stage AS ENUM ('COMPLAINT','WORK_START','RESOLUTION')`);

    // Per-install signing keys. The app keeps the private key in Android Keystore / iOS Secure Enclave.
    await q.query(`
      CREATE TABLE devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key text NOT NULL,
        key_fingerprint char(64) NOT NULL UNIQUE,
        platform varchar(20) NOT NULL,
        app_version varchar(30),
        integrity_verdict varchar(20) NOT NULL DEFAULT 'UNVERIFIED',
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      )`);
    await q.query(`CREATE INDEX devices_user_active_idx ON devices(user_id) WHERE revoked_at IS NULL`);

    await q.query(`
      CREATE TABLE complaint_media (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES users(id),
        device_id uuid NOT NULL REFERENCES devices(id),
        complaint_id uuid REFERENCES complaints(id),
        stage media_stage,
        kind media_kind NOT NULL,
        status media_status NOT NULL,
        content_type varchar(40) NOT NULL,
        declared_bytes integer NOT NULL CHECK (declared_bytes > 0),
        declared_sha256 char(64) NOT NULL,
        staging_key text,
        object_key text,
        thumb_key text,
        stored_content_type varchar(40),
        bytes_stored integer,
        width integer,
        height integer,
        duration_s real,
        captured_at timestamptz,
        location geometry(Point, 4326),
        gps_accuracy_m real,
        manifest jsonb,
        signature text,
        scan_status varchar(20),
        distance_m real,
        outside_geofence boolean,
        reject_reason varchar(200),
        created_at timestamptz NOT NULL DEFAULT now(),
        confirmed_at timestamptz,
        processed_at timestamptz,
        attached_at timestamptz,
        CONSTRAINT media_attach_chk CHECK ((complaint_id IS NULL) = (stage IS NULL))
      )`);
    await q.query(`CREATE INDEX complaint_media_complaint_idx ON complaint_media(complaint_id, stage)`);
    await q.query(`CREATE INDEX complaint_media_owner_idx ON complaint_media(owner_id, status, created_at)`);
    // One signed capture can only ever be used once.
    await q.query(`CREATE UNIQUE INDEX complaint_media_sha_once_idx ON complaint_media(declared_sha256) WHERE status IN ('PROCESSING','READY')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS complaint_media`);
    await q.query(`DROP TABLE IF EXISTS devices`);
    await q.query(`DROP TYPE IF EXISTS media_stage`);
    await q.query(`DROP TYPE IF EXISTS media_status`);
    await q.query(`DROP TYPE IF EXISTS media_kind`);
  }
}
