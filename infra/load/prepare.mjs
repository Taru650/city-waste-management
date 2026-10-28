// Prepares a load-test environment: fresh database with real migrations, moto S3, Redis DB 13,
// one ULB (16 wards, 4 areas with supervisors), 40 workers, 10,000 citizens (LOAD_CITIZENS), a Sub Admin with
// TOTP, and a realistic phone photo. Writes fixtures.json for the k6 script.
import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiEnv, AREAS, CITIZENS, DB_URL, PASSWORD, S3, WORKERS } from './env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '../../apps/api');
const req = createRequire(join(apiDir, 'package.json'));
const pg = req('pg');
const argon2 = req('argon2');
const sharp = req('sharp');

const up = async (url) => fetch(url, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureS3() {
  if (process.env.LOAD_S3 === 'minio') return ensureMinio();
  if (!(await up(S3.endpoint))) {
    const bin = process.env.MOTO_SERVER_BIN ?? (existsSync('/opt/moto-venv/bin/moto_server') ? '/opt/moto-venv/bin/moto_server' : 'moto_server');
    const u = new URL(S3.endpoint);
    spawn(bin, ['-H', u.hostname, '-p', u.port], { stdio: 'ignore', detached: true }).unref();
    for (let i = 0; i < 60 && !(await up(S3.endpoint)); i++) await sleep(250);
  }
  await fetch(`${S3.endpoint}/${S3.bucket}`, { method: 'PUT', body: '<CreateBucketConfiguration><LocationConstraint>ap-south-1</LocationConstraint></CreateBucketConfiguration>' });
}

/** MinIO (the pilot stack's S3), fresh data directory each run. MINIO_BIN or `minio` on PATH. */
async function ensureMinio() {
  const u = new URL(S3.endpoint);
  const dataDir = process.env.MINIO_DATA ?? join(here, 'results/minio-data');
  // Never wipe the directory under a running server (it answers SlowDownWrite forever after).
  const running = spawnSync('pgrep', ['-f', `minio server ${dataDir}`], { encoding: 'utf8' }).stdout.trim();
  if (running) {
    spawnSync('kill', running.split('\n'));
    for (let i = 0; i < 40 && (await up(`${S3.endpoint}/minio/health/live`)); i++) await sleep(250);
  }
  spawnSync('rm', ['-rf', dataDir]);
  spawnSync('mkdir', ['-p', dataDir]);
  if (!(await up(`${S3.endpoint}/minio/health/live`))) {
    spawn(process.env.MINIO_BIN ?? 'minio', ['server', dataDir, '--address', `${u.hostname}:${u.port}`, '--quiet'], {
      stdio: 'ignore', detached: true,
      env: { ...process.env, MINIO_ROOT_USER: apiEnv.S3_ACCESS_KEY_ID, MINIO_ROOT_PASSWORD: apiEnv.S3_SECRET_ACCESS_KEY },
    }).unref();
    for (let i = 0; i < 120 && !(await up(`${S3.endpoint}/minio/health/live`)); i++) await sleep(250);
  }
  const { S3Client, CreateBucketCommand } = req('@aws-sdk/client-s3');
  const s3 = new S3Client({ endpoint: S3.endpoint, region: 'ap-south-1', forcePathStyle: true,
    credentials: { accessKeyId: apiEnv.S3_ACCESS_KEY_ID, secretAccessKey: apiEnv.S3_SECRET_ACCESS_KEY } });
  await s3.send(new CreateBucketCommand({ Bucket: S3.bucket })).catch((e) => { if (e.name !== 'BucketAlreadyOwnedByYou') throw e; });
}

async function resetDatabase() {
  const url = new URL(DB_URL);
  const name = url.pathname.slice(1);
  if (!name.endsWith('_test')) throw new Error(`Refusing to reset ${name}`);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const r = spawnSync('node', [join(apiDir, 'dist/database/run-migrations.js')], { env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`migrations failed: ${r.stderr || r.stdout}`);
}

const encKey = Buffer.from(apiEnv.PII_ENCRYPTION_KEY, 'base64');
const hashKey = Buffer.from(apiEnv.PII_HASH_KEY, 'base64');
const encrypt = (v) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};
const blind = (v) => createHmac('sha256', hashKey).update(v.trim().toLowerCase()).digest('hex');
const square = (lat, lng, s) => JSON.stringify({ type: 'Polygon', coordinates: [[[lng, lat], [lng + s, lat], [lng + s, lat + s], [lng, lat + s], [lng, lat]]] });
const base32 = (buf) => {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  return bits.match(/.{1,5}/g).map((c) => a[parseInt(c.padEnd(5, '0'), 2)]).join('');
};

async function seed() {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

  const [district] = await q(`INSERT INTO districts (lgd_code, name) VALUES (9801, 'Load District') RETURNING id`);
  const [ulb] = await q(`INSERT INTO ulbs (district_id, lgd_code, type, name) VALUES ($1, 980001, 'NAGAR_NIGAM', 'Nagar Nigam Load') RETURNING id`, [district.id]);
  // 4 x 4 wards of 0.01° (~1.1 km) each, 4 areas of 4 wards.
  const wards = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const lat = 22.0 + r * 0.01;
      const lng = 82.0 + c * 0.01;
      const [w] = await q(`INSERT INTO wards (ulb_id, number, geom) VALUES ($1, $2, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))) RETURNING id`,
        [ulb.id, r * 4 + c + 1, square(lat, lng, 0.01)]);
      wards.push({ id: w.id, lat, lng, area: r % AREAS });
    }
  }
  let mobile = 9300000000;
  const user = async (role, name, extra = {}) => {
    const m = String(++mobile);
    const email = `${role.toLowerCase()}${m}@load.example.in`;
    const [u] = await q(
      `INSERT INTO users (role, status, name, mobile_enc, mobile_hash, email_enc, email_hash, password_hash, mfa_enabled, mfa_secret_enc,
                          district_id, ulb_id, home_district_id, home_ulb_id, home_ward_id, preferred_language)
       VALUES ($1, 'ACTIVE', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'en') RETURNING id`,
      [role, name, encrypt(m), blind(m), encrypt(email), blind(email), hash, !!extra.mfaSecret, extra.mfaSecret ? encrypt(extra.mfaSecret) : null,
        role === 'CITIZEN' ? null : district.id, role === 'CITIZEN' ? null : ulb.id,
        role === 'CITIZEN' ? district.id : null, role === 'CITIZEN' ? ulb.id : null, role === 'CITIZEN' ? wards[0].id : null],
    );
    return { id: u.id, mobile: m };
  };
  const supervisors = [];
  for (let a = 0; a < AREAS; a++) {
    const s = await user('SUPERVISOR', `Supervisor ${a + 1}`);
    const [area] = await q(`INSERT INTO areas (ulb_id, name, supervisor_id) VALUES ($1, $2, $3) RETURNING id`, [ulb.id, `Area ${a + 1}`, s.id]);
    await q(`UPDATE wards SET area_id = $1 WHERE id = ANY($2)`, [area.id, wards.filter((w) => w.area === a).map((w) => w.id)]);
    supervisors.push(s);
  }
  const workers = [];
  for (let i = 0; i < WORKERS; i++) workers.push(await user('WORKER', `Worker ${i + 1}`));
  const secret = base32(randomBytes(20));
  const subAdmin = await user('SUB_ADMIN', 'EO Load', { mfaSecret: secret });
  const citizens = [];
  // Batch insert citizens (2,000 single inserts would dominate prepare time).
  for (let i = 0; i < CITIZENS; i++) citizens.push(String(++mobile));
  for (let i = 0; i < citizens.length; i += 500) {
    const chunk = citizens.slice(i, i + 500);
    const values = [];
    const params = [];
    chunk.forEach((m, k) => {
      const email = `citizen${m}@load.example.in`;
      params.push(`Citizen ${m}`, encrypt(m), blind(m), encrypt(email), blind(email), hash, district.id, ulb.id, wards[0].id);
      const b = k * 9;
      values.push(`('CITIZEN','UNVERIFIED_MOBILE',$${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},'en')`);
    });
    await q(`INSERT INTO users (role, status, name, mobile_enc, mobile_hash, email_enc, email_hash, password_hash, home_district_id, home_ulb_id, home_ward_id, preferred_language)
             VALUES ${values.join(',')}`, params);
  }
  const [type] = await q(`SELECT id FROM complaint_types WHERE code = 'GARBAGE_HEAP'`);
  await db.end();
  return { password: PASSWORD, typeId: type.id, wards, supervisors, workers, subAdmin: { ...subAdmin, mfaSecret: secret }, citizens };
}

/** A phone-like photo after on-device compression: 1440x1080, q80, real texture. */
async function photo() {
  const w = 1440, h = 1080;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i += 3) {
    const n = (Math.random() * 60) | 0;
    raw[i] = 80 + n; raw[i + 1] = 100 + ((i / 3) % w) / 30 + n / 2; raw[i + 2] = 60 + n / 3;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
}

await ensureS3();
spawnSync('redis-cli', ['-n', '13', 'flushdb']);
await resetDatabase();
const fixtures = await seed();
const jpg = await photo();
writeFileSync(join(here, 'photo.jpg'), jpg);
writeFileSync(join(here, 'fixtures.json'), JSON.stringify(fixtures));
console.log(`seeded: ${fixtures.citizens.length} citizens, ${fixtures.workers.length} workers, ${fixtures.supervisors.length} supervisors; photo ${(jpg.length / 1024).toFixed(0)} KB`);
