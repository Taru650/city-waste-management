import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1761300000000 implements MigrationInterface {
  name = 'InitialSchema1761300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await q.query(`CREATE TYPE user_role AS ENUM ('WEB_ADMIN','DISTRICT_ADMIN','SUB_ADMIN','SUPERVISOR','WORKER','CITIZEN')`);
    await q.query(`CREATE TYPE user_status AS ENUM ('ACTIVE','UNVERIFIED_MOBILE','DISABLED')`);
    await q.query(`CREATE TYPE ulb_type AS ENUM ('NAGAR_NIGAM','NAGAR_PARISHAD','NAGAR_PANCHAYAT')`);
    await q.query(`CREATE TYPE complaint_status AS ENUM ('PENDING','ASSIGNED','WORK_IN_PROGRESS','RESOLVED','REJECTED','DUPLICATE','REOPENED','CLOSED')`);
    await q.query(`CREATE TYPE ward_source AS ENUM ('GPS','MANUAL')`);

    // ---- Jurisdiction masters (LGD = Local Government Directory codes) ----
    await q.query(`
      CREATE TABLE districts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        lgd_code integer NOT NULL UNIQUE CHECK (lgd_code BETWEEN 1 AND 9999),
        census2011_code integer,
        name varchar(100) NOT NULL,
        name_hi varchar(100),
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE ulbs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        district_id uuid NOT NULL REFERENCES districts(id),
        lgd_code integer NOT NULL UNIQUE CHECK (lgd_code BETWEEN 1 AND 999999),
        type ulb_type NOT NULL,
        name varchar(150) NOT NULL,
        name_hi varchar(150),
        geom geometry(MultiPolygon, 4326),
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX ulbs_district_idx ON ulbs(district_id)`);

    // ---- Users (citizens and staff) ----
    await q.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        role user_role NOT NULL,
        status user_status NOT NULL,
        name varchar(100) NOT NULL,
        guardian_name varchar(100),
        mobile_enc text NOT NULL,
        mobile_hash char(64) NOT NULL UNIQUE,
        email_enc text,
        email_hash char(64) UNIQUE,
        password_hash text NOT NULL,
        must_change_password boolean NOT NULL DEFAULT false,
        token_version integer NOT NULL DEFAULT 0,
        failed_login_count integer NOT NULL DEFAULT 0,
        locked_until timestamptz,
        mfa_enabled boolean NOT NULL DEFAULT false,
        mfa_secret_enc text,
        mfa_last_step bigint,
        district_id uuid REFERENCES districts(id),
        ulb_id uuid REFERENCES ulbs(id),
        area_id uuid,
        home_district_id uuid REFERENCES districts(id),
        home_ulb_id uuid REFERENCES ulbs(id),
        home_ward_id uuid,
        created_by uuid REFERENCES users(id),
        last_login_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_scope_chk CHECK (
          (role = 'WEB_ADMIN')
          OR (role = 'DISTRICT_ADMIN' AND district_id IS NOT NULL)
          OR (role IN ('SUB_ADMIN','SUPERVISOR','WORKER') AND district_id IS NOT NULL AND ulb_id IS NOT NULL)
          OR (role = 'CITIZEN' AND home_ward_id IS NOT NULL)
        )
      )`);
    await q.query(`CREATE INDEX users_ulb_role_idx ON users(ulb_id, role)`);

    await q.query(`
      CREATE TABLE areas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ulb_id uuid NOT NULL REFERENCES ulbs(id),
        name varchar(100) NOT NULL,
        supervisor_id uuid REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (ulb_id, name)
      )`);
    await q.query(`
      CREATE TABLE wards (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ulb_id uuid NOT NULL REFERENCES ulbs(id),
        number integer NOT NULL CHECK (number > 0),
        name varchar(100),
        geom geometry(MultiPolygon, 4326),
        area_id uuid REFERENCES areas(id),
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (ulb_id, number)
      )`);
    await q.query(`CREATE INDEX wards_geom_gix ON wards USING gist(geom)`);
    await q.query(`ALTER TABLE users ADD CONSTRAINT users_area_fk FOREIGN KEY (area_id) REFERENCES areas(id)`);
    await q.query(`ALTER TABLE users ADD CONSTRAINT users_home_ward_fk FOREIGN KEY (home_ward_id) REFERENCES wards(id)`);

    // ---- Sessions and password resets (tokens stored as SHA-256 hashes only) ----
    await q.query(`
      CREATE TABLE refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        family_id uuid NOT NULL,
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        revoked_at timestamptz,
        ip varchar(64),
        user_agent varchar(255),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id)`);
    await q.query(`CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id)`);
    await q.query(`
      CREATE TABLE password_resets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    // ---- Complaints ----
    await q.query(`
      CREATE TABLE complaint_types (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(40) NOT NULL UNIQUE,
        name_en varchar(100) NOT NULL,
        name_hi varchar(100) NOT NULL,
        sla_hours integer NOT NULL CHECK (sla_hours > 0),
        sort_order integer NOT NULL DEFAULT 0,
        active boolean NOT NULL DEFAULT true
      )`);
    await q.query(`
      INSERT INTO complaint_types (code, name_en, name_hi, sla_hours, sort_order) VALUES
        ('GARBAGE_HEAP',   'Garbage heap / kachra',  'कचरे का ढेर',          24, 1),
        ('WATER_LOGGING',  'Water logging',          'जल भराव',              24, 2),
        ('DRAIN_BLOCKAGE', 'Drain / nala blockage',  'नाली / नाला जाम',       48, 3),
        ('DEAD_ANIMAL',    'Dead animal',            'मृत पशु',               12, 4),
        ('PUBLIC_TOILET',  'Public toilet unclean',  'सार्वजनिक शौचालय गंदा',  24, 5),
        ('GARBAGE_BURNING','Burning of garbage',     'कचरा जलाना',            12, 6),
        ('SWEEPING',       'Road sweeping not done', 'सड़क की सफाई नहीं हुई',   24, 7),
        ('OTHER',          'Other',                  'अन्य',                  72, 99)`);
    await q.query(`
      CREATE TABLE complaint_seq (
        ulb_id uuid NOT NULL REFERENCES ulbs(id),
        year integer NOT NULL,
        last_value integer NOT NULL DEFAULT 0,
        PRIMARY KEY (ulb_id, year)
      )`);
    await q.query(`
      CREATE TABLE complaints (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        complaint_no char(18) NOT NULL UNIQUE,
        citizen_id uuid NOT NULL REFERENCES users(id),
        district_id uuid NOT NULL REFERENCES districts(id),
        ulb_id uuid NOT NULL REFERENCES ulbs(id),
        ward_id uuid NOT NULL REFERENCES wards(id),
        area_id uuid REFERENCES areas(id),
        ward_source ward_source NOT NULL,
        ward_mismatch boolean NOT NULL DEFAULT false,
        type_id uuid NOT NULL REFERENCES complaint_types(id),
        landmark varchar(50),
        description varchar(250) NOT NULL,
        location geometry(Point, 4326) NOT NULL,
        gps_accuracy_m real,
        status complaint_status NOT NULL,
        supervisor_id uuid REFERENCES users(id),
        worker_id uuid REFERENCES users(id),
        duplicate_of uuid REFERENCES complaints(id),
        reopen_count integer NOT NULL DEFAULT 0,
        escalated boolean NOT NULL DEFAULT false,
        sla_due_at timestamptz NOT NULL,
        assigned_at timestamptz,
        resolved_at timestamptz,
        closed_at timestamptz,
        resolution_remark varchar(500),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX complaints_ulb_status_idx ON complaints(ulb_id, status, created_at)`);
    await q.query(`CREATE INDEX complaints_district_idx ON complaints(district_id, created_at)`);
    await q.query(`CREATE INDEX complaints_supervisor_idx ON complaints(supervisor_id, status)`);
    await q.query(`CREATE INDEX complaints_worker_idx ON complaints(worker_id, status)`);
    await q.query(`CREATE INDEX complaints_citizen_idx ON complaints(citizen_id, created_at)`);
    await q.query(`CREATE INDEX complaints_location_gix ON complaints USING gist(location)`);

    await q.query(`
      CREATE TABLE complaint_events (
        id bigserial PRIMARY KEY,
        complaint_id uuid NOT NULL REFERENCES complaints(id),
        action varchar(30) NOT NULL,
        from_status complaint_status,
        to_status complaint_status NOT NULL,
        actor_id uuid REFERENCES users(id),
        remark varchar(500),
        meta jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX complaint_events_complaint_idx ON complaint_events(complaint_id, created_at)`);

    await q.query(`
      CREATE TABLE feedback (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        complaint_id uuid NOT NULL REFERENCES complaints(id),
        citizen_id uuid NOT NULL REFERENCES users(id),
        rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
        remark varchar(250),
        reopen_requested boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX feedback_complaint_idx ON feedback(complaint_id)`);

    await q.query(`
      CREATE TABLE audit_logs (
        id bigserial PRIMARY KEY,
        actor_id uuid REFERENCES users(id),
        action varchar(60) NOT NULL,
        entity varchar(40),
        entity_id varchar(64),
        ip varchar(64),
        meta jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_id, created_at)`);

    // History tables are append-only: block UPDATE/DELETE at the database level.
    await q.query(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
      END $$ LANGUAGE plpgsql`);
    for (const table of ['complaint_events', 'audit_logs', 'feedback']) {
      await q.query(`CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table}
                     FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
      // Row triggers do not fire on TRUNCATE.
      await q.query(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
                     FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of [
      'audit_logs', 'feedback', 'complaint_events', 'complaints', 'complaint_seq', 'complaint_types',
      'password_resets', 'refresh_tokens',
    ]) {
      await q.query(`DROP TABLE IF EXISTS ${t}`);
    }
    await q.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_area_fk`);
    await q.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_home_ward_fk`);
    await q.query(`DROP TABLE IF EXISTS wards`);
    await q.query(`DROP TABLE IF EXISTS areas`);
    await q.query(`DROP TABLE IF EXISTS users`);
    await q.query(`DROP TABLE IF EXISTS ulbs`);
    await q.query(`DROP TABLE IF EXISTS districts`);
    await q.query(`DROP FUNCTION IF EXISTS forbid_mutation`);
    for (const t of ['ward_source', 'complaint_status', 'ulb_type', 'user_status', 'user_role']) {
      await q.query(`DROP TYPE IF EXISTS ${t}`);
    }
  }
}
