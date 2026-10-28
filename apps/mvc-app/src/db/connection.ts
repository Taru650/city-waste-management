import knex, { Knex } from 'knex';
import { getConfig } from '@/config/env';

/**
 * The one database connection pool (Knex over mysql2), shared by models, services and scripts.
 * Every session runs in UTC with strict SQL mode, so times are stored and compared the same way
 * on every machine (including Windows machines set to another time zone).
 */
export function connectionSettings(database?: string): Knex.Config {
  const c = getConfig();
  return {
    client: 'mysql2',
    connection: {
      host: c.db.host,
      port: c.db.port,
      user: c.db.user,
      password: c.db.password,
      database: database ?? c.db.name,
      charset: 'utf8mb4',
      timezone: 'Z',
      connectTimeout: c.db.connectTimeoutMs,
      decimalNumbers: true,
      // TINYINT(1) columns are booleans in this app.
      typeCast(field: { type: string; length: number; string(): string | null }, next: () => unknown) {
        if (field.type === 'TINY' && field.length === 1) {
          const v = field.string();
          return v === null ? null : v === '1';
        }
        return next();
      },
    },
    pool: {
      min: 0,
      max: c.db.poolMax,
      afterCreate(conn: { query(sql: string, cb: (err: Error | null) => void): void }, done: (err: Error | null, conn: unknown) => void) {
        conn.query(
          `SET time_zone = '+00:00', sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO',
           max_execution_time = ${c.db.queryTimeoutMs}, innodb_lock_wait_timeout = 10`,
          (err) => done(err, conn),
        );
      },
    },
    acquireConnectionTimeout: c.db.connectTimeoutMs,
  };
}

const globalForDb = globalThis as unknown as { __cwmDb?: Knex };

/** Shared pool. In development Next reloads modules often, so the pool lives on `globalThis`. */
export function db(): Knex {
  if (!globalForDb.__cwmDb) globalForDb.__cwmDb = knex(connectionSettings());
  return globalForDb.__cwmDb;
}

export async function closeDb() {
  if (globalForDb.__cwmDb) {
    await globalForDb.__cwmDb.destroy();
    globalForDb.__cwmDb = undefined;
  }
}
