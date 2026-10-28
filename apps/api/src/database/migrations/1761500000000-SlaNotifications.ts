import { MigrationInterface, QueryRunner } from 'typeorm';

export class SlaNotifications1761500000000 implements MigrationInterface {
  name = 'SlaNotifications1761500000000';

  public async up(q: QueryRunner): Promise<void> {
    // SLA tracking: set once by the sweeper, cleared when a reopen restarts the clock.
    await q.query(`ALTER TABLE complaints ADD COLUMN sla_breached_at timestamptz, ADD COLUMN escalated_at timestamptz`);
    await q.query(`CREATE INDEX complaints_open_sla_idx ON complaints(sla_due_at)
                   WHERE status IN ('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`);

    await q.query(`ALTER TABLE users ADD COLUMN preferred_language char(2) NOT NULL DEFAULT 'hi' CHECK (preferred_language IN ('hi','en'))`);

    // In-app notifications double as the push outbox: written in the same transaction as the
    // status change, dispatched to FCM afterwards by the worker.
    await q.query(`CREATE TYPE push_status AS ENUM ('PENDING','SENT','FAILED','SKIPPED')`);
    await q.query(`
      CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type varchar(40) NOT NULL,
        complaint_id uuid REFERENCES complaints(id),
        title_en varchar(120) NOT NULL,
        title_hi varchar(120) NOT NULL,
        body_en varchar(300) NOT NULL,
        body_hi varchar(300) NOT NULL,
        push_status push_status NOT NULL DEFAULT 'PENDING',
        push_attempts smallint NOT NULL DEFAULT 0,
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC)`);
    await q.query(`CREATE INDEX notifications_push_pending_idx ON notifications(created_at) WHERE push_status = 'PENDING'`);

    await q.query(`
      CREATE TABLE push_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token text NOT NULL UNIQUE,
        platform varchar(20) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX push_tokens_user_idx ON push_tokens(user_id)`);

    await q.query(`
      CREATE TABLE mfa_recovery_codes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash char(64) NOT NULL UNIQUE,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes(user_id)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS mfa_recovery_codes`);
    await q.query(`DROP TABLE IF EXISTS push_tokens`);
    await q.query(`DROP TABLE IF EXISTS notifications`);
    await q.query(`DROP TYPE IF EXISTS push_status`);
    await q.query(`ALTER TABLE users DROP COLUMN IF EXISTS preferred_language`);
    await q.query(`DROP INDEX IF EXISTS complaints_open_sla_idx`);
    await q.query(`ALTER TABLE complaints DROP COLUMN IF EXISTS sla_breached_at, DROP COLUMN IF EXISTS escalated_at`);
  }
}
