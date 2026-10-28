import { MigrationInterface, QueryRunner } from 'typeorm';

export class Privacy1761800000000 implements MigrationInterface {
  name = 'Privacy1761800000000';

  public async up(q: QueryRunner): Promise<void> {
    // DPDP Act 2023: consent is recorded per notice version and purpose; withdrawing it closes the
    // account (the service has no other purpose).
    await q.query(`
      CREATE TABLE consents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose varchar(40) NOT NULL,
        notice_version varchar(20) NOT NULL,
        language char(2) NOT NULL,
        granted_at timestamptz NOT NULL DEFAULT now(),
        withdrawn_at timestamptz
      )`);
    await q.query(`CREATE INDEX consents_user_idx ON consents(user_id)`);
    // Erasure removes contact details; the anonymised row keeps complaint history consistent.
    await q.query(`ALTER TABLE users ALTER COLUMN mobile_enc DROP NOT NULL, ALTER COLUMN mobile_hash DROP NOT NULL, ADD COLUMN erased_at timestamptz`);
    await q.query(`ALTER TABLE users ADD CONSTRAINT users_contact_chk CHECK (erased_at IS NOT NULL OR (mobile_enc IS NOT NULL AND mobile_hash IS NOT NULL))`);
    // Accounts created before consent recording existed: their consent is "unrecorded", they are asked at next sign-in.

    // Feedback stays append-only (ratings drive the quality reports), with one exception for
    // erasure: the citizen's free-text remark may be cleared, and nothing else may change.
    await q.query(`
      CREATE FUNCTION feedback_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.remark IS NULL
           AND (NEW.id, NEW.complaint_id, NEW.citizen_id, NEW.rating, NEW.reopen_requested, NEW.created_at)
               IS NOT DISTINCT FROM (OLD.id, OLD.complaint_id, OLD.citizen_id, OLD.rating, OLD.reopen_requested, OLD.created_at) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'feedback is append-only (only clearing the remark for erasure is allowed)';
      END $$ LANGUAGE plpgsql`);
    await q.query(`DROP TRIGGER feedback_append_only ON feedback`);
    await q.query(`CREATE TRIGGER feedback_append_only BEFORE UPDATE OR DELETE ON feedback FOR EACH ROW EXECUTE FUNCTION feedback_guard()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER feedback_append_only ON feedback`);
    await q.query(`CREATE TRIGGER feedback_append_only BEFORE UPDATE OR DELETE ON feedback FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    await q.query(`DROP FUNCTION feedback_guard()`);
    await q.query(`ALTER TABLE users DROP CONSTRAINT users_contact_chk, DROP COLUMN erased_at`);
    await q.query(`DROP TABLE consents`);
  }
}
