import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import type { DbLimits } from '../config/configuration';
import { InitialSchema1761300000000 } from './migrations/1761300000000-InitialSchema';
import { MediaPipeline1761400000000 } from './migrations/1761400000000-MediaPipeline';
import { SlaNotifications1761500000000 } from './migrations/1761500000000-SlaNotifications';
import { Attestation1761600000000 } from './migrations/1761600000000-Attestation';
import { EventZones1761700000000 } from './migrations/1761700000000-EventZones';
import { Privacy1761800000000 } from './migrations/1761800000000-Privacy';
import { ReportIndexes1761900000000 } from './migrations/1761900000000-ReportIndexes';
import { DuplicateSearchIndex1762000000000 } from './migrations/1762000000000-DuplicateSearchIndex';

export const MIGRATIONS = [InitialSchema1761300000000, MediaPipeline1761400000000, SlaNotifications1761500000000, Attestation1761600000000, EventZones1761700000000, Privacy1761800000000, ReportIndexes1761900000000, DuplicateSearchIndex1762000000000];

/**
 * Queries are written in SQL through the DataSource (PostGIS-heavy, and keeps
 * every scope filter explicit and reviewable); TypeORM is used for pooling,
 * transactions and migrations only.
 */
export function dataSourceOptions(url: string, limits?: DbLimits): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    migrations: MIGRATIONS,
    migrationsTableName: 'schema_migrations',
    synchronize: false,
    logging: false,
    // With limits (API, worker): a runaway query or a transaction left open cannot hold a connection
    // for ever, and a request waiting for a free connection fails after a while instead of hanging.
    // Without (migrations, seed, key rotation): long one-off work is expected.
    extra: limits
      ? {
          max: limits.poolMax,
          statement_timeout: limits.statementTimeoutMs,
          idle_in_transaction_session_timeout: limits.idleInTransactionTimeoutMs,
          connectionTimeoutMillis: limits.connectionTimeoutMs,
        }
      : { max: 20 },
  };
}

export function createDataSource(url: string): DataSource {
  return new DataSource(dataSourceOptions(url));
}
