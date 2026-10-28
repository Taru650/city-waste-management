import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReportIndexes1761900000000 implements MigrationInterface {
  name = 'ReportIndexes1761900000000';

  public async up(q: QueryRunner): Promise<void> {
    // The trend report reads events from the start of its range onward (M9 report scaling).
    await q.query(`CREATE INDEX IF NOT EXISTS complaint_events_created_idx ON complaint_events(created_at)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS complaint_events_created_idx`);
  }
}
