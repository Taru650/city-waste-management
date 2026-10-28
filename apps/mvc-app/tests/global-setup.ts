import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Once per test run: rebuild the TEST database from the migrations.
 * Safety: it only ever touches the database named by DB_TEST_NAME, and refuses names without "test".
 */
export default async function setup() {
  (process.env as Record<string, string>).NODE_ENV = 'test';
  const { getConfig } = await import('../src/config/env');
  Object.assign(process.env, {
    JWT_ACCESS_SECRET: 'test-access-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
    PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PII_HASH_KEY: Buffer.alloc(32, 9).toString('base64'),
  });
  const cfg = getConfig();
  rmSync(path.resolve(__dirname, '..', 'storage-test'), { recursive: true, force: true }); // files of the previous run
  if (!/test/i.test(cfg.db.name)) throw new Error(`Refusing to run tests against "${cfg.db.name}": set DB_TEST_NAME to a database with "test" in its name.`);

  const { default: knex } = await import('knex');
  const { connectionSettings } = await import('../src/db/connection');
  const k = knex(connectionSettings());
  try {
    await k.raw('SET FOREIGN_KEY_CHECKS = 0');
    const [tables] = (await k.raw('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"')) as unknown as [Record<string, string>[]];
    for (const t of tables) await k.raw('DROP TABLE IF EXISTS ??', [Object.values(t)[0]]);
    await k.raw('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await k.destroy();
  }

  // Same command a developer runs (npm run db:migrate), under tsx, which resolves the .ts migrations.
  const root = path.resolve(__dirname, '..');
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/db.ts', 'migrate'], { cwd: root, env: process.env, stdio: 'inherit' });

  const k2 = knex(connectionSettings());
  try {
    // Each test file takes a fresh map region from this counter so ward boundaries never overlap between files.
    await k2.raw('CREATE TABLE test_region_seq (n int NOT NULL AUTO_INCREMENT PRIMARY KEY)');
  } finally {
    await k2.destroy();
  }
}
