import { MigrationInterface, QueryRunner } from 'typeorm';

const INDEX = 'complaints_location_geog_gix';

/**
 * Duplicate candidates are searched in metres with ST_DWithin(location::geography, …), which the
 * geometry index on complaints.location cannot serve, so every lookup scanned the whole table
 * (643 ms at 365k complaints; 8.6 ms with this index, docs/ops/AUDIT-2026-10.md). The index is on
 * the same cast expression the query uses; column types and spatial semantics are unchanged.
 *
 * Built CONCURRENTLY so complaints keep being filed while it builds, which cannot run inside a
 * transaction. A failed concurrent build leaves an INVALID index behind; it is dropped first.
 */
export class DuplicateSearchIndex1762000000000 implements MigrationInterface {
  name = 'DuplicateSearchIndex1762000000000';
  transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    const [invalid] = await q.query(
      `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND NOT i.indisvalid`,
      [INDEX],
    );
    if (invalid) await q.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`);
    await q.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON complaints USING gist ((location::geography))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`);
  }
}
