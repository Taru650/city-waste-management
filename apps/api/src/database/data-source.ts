import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { InitialSchema1761300000000 } from './migrations/1761300000000-InitialSchema';
import { MediaPipeline1761400000000 } from './migrations/1761400000000-MediaPipeline';

export const MIGRATIONS = [InitialSchema1761300000000, MediaPipeline1761400000000];

/**
 * Queries are written in SQL through the DataSource (PostGIS-heavy, and keeps
 * every scope filter explicit and reviewable); TypeORM is used for pooling,
 * transactions and migrations only.
 */
export function dataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    migrations: MIGRATIONS,
    migrationsTableName: 'schema_migrations',
    synchronize: false,
    logging: false,
    extra: { max: 20 },
  };
}

export function createDataSource(url: string): DataSource {
  return new DataSource(dataSourceOptions(url));
}
