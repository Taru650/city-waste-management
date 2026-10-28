import { MigrationInterface, QueryRunner } from 'typeorm';

export class Attestation1761600000000 implements MigrationInterface {
  name = 'Attestation1761600000000';

  public async up(q: QueryRunner): Promise<void> {
    // Play Integrity: verdicts like MEETS_STRONG_INTEGRITY do not fit the original varchar(20).
    await q.query(`ALTER TABLE devices ALTER COLUMN integrity_verdict TYPE varchar(30), ADD COLUMN integrity_checked_at timestamptz`);
    // Replay protection: a verified nonce is accepted once.
    await q.query(`CREATE TABLE attestation_nonces (nonce_hash bytea PRIMARY KEY, expires_at timestamptz NOT NULL)`);
    await q.query(`CREATE INDEX attestation_nonces_expiry_idx ON attestation_nonces(expires_at)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE attestation_nonces`);
    await q.query(`ALTER TABLE devices DROP COLUMN integrity_checked_at, ALTER COLUMN integrity_verdict TYPE varchar(20)`);
  }
}
