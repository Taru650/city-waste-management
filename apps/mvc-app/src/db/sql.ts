import type { Knex } from 'knex';

/** Either the pool or an open transaction: models take this so services can group them. */
export type Db = Knex | Knex.Transaction;
export type Row = Record<string, any>;  

/** SELECT: all rows. Placeholders are `?`; arrays expand for IN (?). */
export async function query<T = Row>(d: Db, sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const [rows] = (await d.raw(sql, params as never)) as unknown as [T[]];
  return rows;
}

/** SELECT: the first row, or undefined. */
export async function one<T = Row>(d: Db, sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
  return (await query<T>(d, sql, params))[0];
}

/** INSERT / UPDATE / DELETE: how many rows it changed (MySQL has no RETURNING, so callers check this). */
export async function run(d: Db, sql: string, params: readonly unknown[] = []): Promise<{ affectedRows: number; insertId: number }> {
  const [res] = (await d.raw(sql, params as never)) as unknown as [{ affectedRows: number; insertId: number }];
  return { affectedRows: res.affectedRows, insertId: res.insertId };
}

/** SQL for a WGS84 point from longitude/latitude (MySQL stores SRID 4326 as latitude-longitude; this keeps callers in lng/lat). */
export const POINT_SQL = `ST_PointFromText(CONCAT('POINT(', ?, ' ', ?, ')'), 4326, 'axis-order=long-lat')`;
/** Bind order for POINT_SQL. */
export const pointParams = (lng: number, lat: number): [number, number] => [lng, lat];
