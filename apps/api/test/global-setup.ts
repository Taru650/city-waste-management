import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { spawn, spawnSync } from 'child_process';
import IORedis from 'ioredis';
import { existsSync } from 'fs';
import { Client } from 'pg';
import './test-env';
import { createDataSource } from '../src/database/data-source';

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * S3 for tests: uses S3_ENDPOINT if something already listens there (MinIO, LocalStack, moto),
 * otherwise starts moto_server (pip install "moto[server]"; MOTO_SERVER_BIN to override the path).
 */
async function ensureS3() {
  const endpoint = process.env.S3_ENDPOINT!;
  if (!(await reachable(endpoint))) {
    const bin = process.env.MOTO_SERVER_BIN ?? (existsSync('/opt/moto-venv/bin/moto_server') ? '/opt/moto-venv/bin/moto_server' : 'moto_server');
    const url = new URL(endpoint);
    const child = spawn(bin, ['-H', url.hostname, '-p', url.port], { stdio: 'ignore', detached: true });
    child.unref();
    (globalThis as { __MOTO_PID__?: number }).__MOTO_PID__ = child.pid;
    for (let i = 0; i < 60 && !(await reachable(endpoint)); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await reachable(endpoint))) throw new Error(`No S3 endpoint at ${endpoint} and moto_server could not be started`);
  }
  const s3 = new S3Client({
    endpoint, region: process.env.S3_REGION, forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  await s3
    .send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET, CreateBucketConfiguration: { LocationConstraint: 'ap-south-1' } }))
    .catch((err) => {
      if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(err.name)) throw err;
    });
}

/** Redis for BullMQ: starts a local redis-server if none is running, then empties the test DB. */
async function ensureRedis() {
  const url = new URL(process.env.REDIS_URL!);
  if (url.pathname !== '/15') throw new Error('Tests must use Redis DB 15 (REDIS_URL=redis://host:port/15)');
  const tryPing = async () => {
    const r = new IORedis(url.toString(), { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    try {
      await r.connect();
      return r;
    } catch {
      r.disconnect();
      return null;
    }
  };
  let redis = await tryPing();
  if (!redis) {
    spawnSync('redis-server', ['--daemonize', 'yes', '--bind', url.hostname, '--port', url.port || '6379', '--save', ''], { stdio: 'ignore' });
    for (let i = 0; i < 40 && !redis; i++) {
      await new Promise((r) => setTimeout(r, 250));
      redis = await tryPing();
    }
    if (!redis) throw new Error(`No Redis at ${url.host}`);
  }
  await redis.flushdb();
  redis.disconnect();
}

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

  await ensureS3();
  await ensureRedis();
}
