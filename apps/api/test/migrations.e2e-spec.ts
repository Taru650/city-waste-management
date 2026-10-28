import { DuplicateSearchIndex1762000000000 } from '../src/database/migrations/1762000000000-DuplicateSearchIndex';
import { createTestApp, TestCtx } from './helpers';

describe('Migrations', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(() => ctx.app.close());

  const indexState = async () =>
    (await ctx.ds.query(`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'complaints_location_geog_gix'`))[0];

  it('duplicate search index: valid, used by the duplicate query, and reversible', async () => {
    expect(await indexState()).toEqual({ valid: true });
    // The planner can serve the exact expression the duplicate query uses (tiny test tables would
    // otherwise be scanned sequentially, so sequential scans are switched off for this check).
    const plan = await ctx.ds.transaction(async (m) => {
      await m.query('SET LOCAL enable_seqscan = off');
      return m.query(
        `EXPLAIN SELECT id FROM complaints c
          WHERE ST_DWithin(c.location::geography, ST_SetSRID(ST_MakePoint(77.2, 28.6), 4326)::geography, 50)`,
      );
    });
    expect(JSON.stringify(plan)).toContain('complaints_location_geog_gix');

    const migration = new DuplicateSearchIndex1762000000000();
    const qr = ctx.ds.createQueryRunner();
    try {
      await migration.down(qr);
      expect(await indexState()).toBeUndefined();
      await migration.up(qr);
      await migration.up(qr); // re-running is harmless
      expect(await indexState()).toEqual({ valid: true });
    } finally {
      await qr.release();
    }
  });
});
