import { DataSource, EntityManager } from 'typeorm';

/**
 * TypeORM's postgres driver returns `[rows, rowCount]` for UPDATE/DELETE but plain
 * `rows` for everything else. Use this for UPDATE/DELETE ... RETURNING so callers
 * always get the row array (destructuring the raw result would silently give the array).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mutateReturning<T = any>(db: DataSource | EntityManager, sql: string, params: unknown[]): Promise<T[]> {
  const raw = await db.query(sql, params);
  return Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0]) && typeof raw[1] === 'number' ? raw[0] : raw;
}
