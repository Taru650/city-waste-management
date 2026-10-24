import { Client } from 'pg';
import './test-env';
import { createDataSource } from '../src/database/data-source';

/** Fresh database per test run, schema built from the real migrations. */
export default async function globalSetup() {
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(dbName)) throw new Error(`Refusing to reset non-test database "${dbName}"`);
  const admin = new Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const ds = await createDataSource(url.toString()).initialize();
  await ds.runMigrations({ transaction: 'each' });
  await ds.query(`CREATE SEQUENCE test_region_seq`);
  await ds.destroy();
}
