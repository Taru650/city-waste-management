// Prepares the e2e environment before the API starts: S3 (moto), Redis, a fresh database
// with real migrations, and seed data with known credentials. Writes e2e/.auth/fixtures.json.
import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import pg from 'pg';
import { apiEnv, DB_URL, PASSWORD, S3 } from './env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '../../api');
const apiRequire = createRequire(join(apiDir, 'package.json'));
const sharp = apiRequire('sharp');

const up = async (url) => fetch(url, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureS3() {
  if (!(await up(S3.endpoint))) {
    const bin = process.env.MOTO_SERVER_BIN ?? (existsSync('/opt/moto-venv/bin/moto_server') ? '/opt/moto-venv/bin/moto_server' : 'moto_server');
    const u = new URL(S3.endpoint);
    spawn(bin, ['-H', u.hostname, '-p', u.port], { stdio: 'ignore', detached: true }).unref();
    for (let i = 0; i < 60 && !(await up(S3.endpoint)); i++) await sleep(250);
  }
  await fetch(`${S3.endpoint}/${S3.bucket}`, {
    method: 'PUT',
    body: '<CreateBucketConfiguration><LocationConstraint>ap-south-1</LocationConstraint></CreateBucketConfiguration>',
  });
}

function ensureRedis() {
  const ping = spawnSync('redis-cli', ['-n', '14', 'ping'], { encoding: 'utf8' });
  if (!ping.stdout?.includes('PONG')) spawnSync('redis-server', ['--daemonize', 'yes', '--bind', '127.0.0.1', '--save', '']);
  spawnSync('redis-cli', ['-n', '14', 'flushdb']);
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

// Same field protection as the API (AES-256-GCM, HMAC blind index).
const encKey = Buffer.from(apiEnv.PII_ENCRYPTION_KEY, 'base64');
const hashKey = Buffer.from(apiEnv.PII_HASH_KEY, 'base64');
const encrypt = (v) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};
const blind = (v) => createHmac('sha256', hashKey).update(v.trim().toLowerCase()).digest('hex');
const square = (lat, lng, s = 0.01) => JSON.stringify({ type: 'Polygon', coordinates: [[[lng, lat], [lng + s, lat], [lng + s, lat + s], [lng, lat + s], [lng, lat]]] });

async function seed() {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

  const [district] = await q(`INSERT INTO districts (lgd_code, name, name_hi) VALUES (9901, 'E2E District', 'परीक्षण जिला') RETURNING id`);
  const [ulbA] = await q(`INSERT INTO ulbs (district_id, lgd_code, type, name) VALUES ($1, 990001, 'NAGAR_NIGAM', 'Nagar Nigam Alpha') RETURNING id`, [district.id]);
  const [ulbB] = await q(`INSERT INTO ulbs (district_id, lgd_code, type, name) VALUES ($1, 990002, 'NAGAR_PARISHAD', 'Nagar Parishad Beta') RETURNING id`, [district.id]);
  const ward = async (ulb, number, lat, lng) =>
    (await q(`INSERT INTO wards (ulb_id, number, name, geom) VALUES ($1, $2, $3, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))) RETURNING id`,
      [ulb, number, `Ward ${number} name`, square(lat, lng)]))[0].id;
  const wA1 = await ward(ulbA.id, 1, 25.0, 80.0);
  const wA2 = await ward(ulbA.id, 2, 25.0, 80.01);
  const wB1 = await ward(ulbB.id, 1, 25.0, 80.1);

  let mobile = 9100000000;
  const users = {};
  const user = async (key, role, o = {}) => {
    const m = String(++mobile);
    const email = `${key.toLowerCase()}@e2e.example.gov.in`;
    const secret = o.mfa ? authenticator.generateSecret(20) : null;
    const [u] = await q(
      `INSERT INTO users (role, status, name, mobile_enc, mobile_hash, email_enc, email_hash, password_hash, must_change_password,
                          mfa_enabled, mfa_secret_enc, district_id, ulb_id, home_district_id, home_ulb_id, home_ward_id, preferred_language)
       VALUES ($1, 'ACTIVE', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'en') RETURNING id`,
      [role, o.name ?? key, encrypt(m), blind(m), encrypt(email), blind(email), hash, !!o.mustChange, !!secret, secret ? encrypt(secret) : null,
        o.district ?? null, o.ulb ?? null, o.homeDistrict ?? null, o.homeUlb ?? null, o.homeWard ?? null],
    );
    users[key] = { id: u.id, role, mobile: m, email, password: PASSWORD, mfaSecret: secret };
    return u.id;
  };
  await user('webAdmin', 'WEB_ADMIN', { mfa: true, name: 'State Web Admin' });
  await user('districtAdmin', 'DISTRICT_ADMIN', { mfa: true, district: district.id, name: 'District Collector Office' });
  await user('subAdminA', 'SUB_ADMIN', { mfa: true, district: district.id, ulb: ulbA.id, name: 'EO Alpha' });
  await user('subAdminB', 'SUB_ADMIN', { mfa: true, district: district.id, ulb: ulbB.id, name: 'EO Beta' });
  await user('newSubAdmin', 'SUB_ADMIN', { district: district.id, ulb: ulbA.id, name: 'New EO' });
  await user('recoverySubAdmin', 'SUB_ADMIN', { mfa: true, district: district.id, ulb: ulbA.id, name: 'Recovery EO' });
  await user('supervisorA', 'SUPERVISOR', { district: district.id, ulb: ulbA.id, name: 'Ramesh Supervisor' });
  await user('tempSupervisor', 'SUPERVISOR', { district: district.id, ulb: ulbA.id, name: 'Temp Supervisor', mustChange: true });
  await user('workerA1', 'WORKER', { district: district.id, ulb: ulbA.id, name: 'Sunita Worker' });
  await user('workerA2', 'WORKER', { district: district.id, ulb: ulbA.id, name: 'Mohan Worker' });
  await user('citizen', 'CITIZEN', { homeDistrict: district.id, homeUlb: ulbA.id, homeWard: wA1, name: 'Asha Citizen' });

  const [area] = await q(`INSERT INTO areas (ulb_id, name, supervisor_id) VALUES ($1, 'Area North', $2) RETURNING id`, [ulbA.id, users.supervisorA.id]);
  await q(`UPDATE wards SET area_id = $1 WHERE id = $2`, [area.id, wA1]);
  const [type] = await q(`SELECT id FROM complaint_types WHERE code = 'GARBAGE_HEAP'`);
  const [device] = await q(`INSERT INTO devices (user_id, public_key, key_fingerprint, platform) VALUES ($1, 'seed', $2, 'ANDROID') RETURNING id`,
    [users.citizen.id, randomBytes(32).toString('hex')]);

  const yy = String(new Date().getFullYear() % 100).padStart(2, '0');
  let seq = 0;
  const complaints = {};
  const complaint = async (key, o) => {
    const no = `9901${o.ulbLgd}${yy}${String(++seq).padStart(6, '0')}`;
    const [c] = await q(
      `INSERT INTO complaints (complaint_no, citizen_id, district_id, ulb_id, ward_id, area_id, ward_source, type_id, landmark, description, location,
                               status, supervisor_id, sla_due_at, resolved_at, closed_at, created_at, assigned_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'GPS', $7, $8, $9, ST_SetSRID(ST_MakePoint($11, $10), 4326), $12, $13,
               now() - make_interval(hours => $14) + interval '24 hours', $15, $16, now() - make_interval(hours => $14), $17)
       RETURNING id`,
      [no, users.citizen.id, district.id, o.ulb, o.ward, o.area ?? null, type.id, o.landmark ?? null, o.description, o.lat, o.lng, o.status,
        o.supervisor ?? null, o.ageHours, o.resolved ? new Date(Date.now() - (o.ageHours - 10) * 3600_000) : null,
        o.status === 'CLOSED' ? new Date(Date.now() - (o.ageHours - 11) * 3600_000) : null,
        o.supervisor ? new Date(Date.now() - o.ageHours * 3600_000) : null],
    );
    const at = (h) => new Date(Date.now() - h * 3600_000);
    await q(`INSERT INTO complaint_events (complaint_id, action, to_status, created_at) VALUES ($1, 'CREATE', 'PENDING', $2)`, [c.id, at(o.ageHours)]);
    if (o.supervisor) await q(`INSERT INTO complaint_events (complaint_id, action, from_status, to_status, created_at) VALUES ($1, 'ROUTE', 'PENDING', 'ASSIGNED', $2)`, [c.id, at(o.ageHours)]);
    if (o.resolved) {
      await q(`INSERT INTO complaint_events (complaint_id, action, from_status, to_status, remark, created_at) VALUES ($1, 'RESOLVE', 'ASSIGNED', 'RESOLVED', 'Cleaned', $2)`, [c.id, at(o.ageHours - 10)]);
      await q(`INSERT INTO complaint_events (complaint_id, action, from_status, to_status, created_at) VALUES ($1, 'CLOSE', 'RESOLVED', 'CLOSED', $2)`, [c.id, at(o.ageHours - 11)]);
      await q(`INSERT INTO feedback (complaint_id, citizen_id, rating, remark) VALUES ($1, $2, 4, 'Good work')`, [c.id, users.citizen.id]);
    }
    complaints[key] = { id: c.id, no: `${no.slice(0, 4)}-${no.slice(4, 10)}-${no.slice(10, 12)}-${no.slice(12)}` };
    return c.id;
  };
  const A = { ulb: ulbA.id, ulbLgd: '990001' };
  await complaint('assigned', { ...A, ward: wA1, area: area.id, supervisor: users.supervisorA.id, status: 'ASSIGNED', ageHours: 50, lat: 25.005, lng: 80.005,
    landmark: 'Near Shiv Mandir', description: 'Kachra ka dher 3 din se pada hai' });
  await complaint('closed', { ...A, ward: wA1, area: area.id, supervisor: users.supervisorA.id, status: 'CLOSED', resolved: true, ageHours: 72, lat: 25.004, lng: 80.004,
    description: 'Drain blocked near school' });
  await complaint('pending', { ...A, ward: wA2, status: 'PENDING', ageHours: 2, lat: 25.005, lng: 80.015, description: 'Garbage burning on road side' });
  await complaint('xss', { ...A, ward: wA1, area: area.id, supervisor: users.supervisorA.id, status: 'ASSIGNED', ageHours: 5, lat: 25.006, lng: 80.006,
    description: '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> garbage here' });
  await complaint('beta', { ulb: ulbB.id, ulbLgd: '990002', ward: wB1, status: 'PENDING', ageHours: 3, lat: 25.005, lng: 80.105, description: 'Beta ULB complaint' });

  // A real photo in S3 for the "assigned" complaint, so the evidence gallery loads through the CSP.
  // Keys are unique per run: the moto version used in tests answers 403 when an object is overwritten.
  const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 120, g: 150, b: 90 } } }).jpeg().toBuffer();
  const thumb = await sharp(jpeg).resize(320).jpeg().toBuffer();
  const run = Date.now().toString(36);
  const photoKey = `media/e2e/${run}/photo-1.jpg`;
  const thumbKey = `media/e2e/${run}/photo-1.thumb.jpg`;
  for (const [key, body] of [[photoKey, jpeg], [thumbKey, thumb]]) {
    const res = await fetch(`${S3.endpoint}/${S3.bucket}/${key}`, { method: 'PUT', body, headers: { 'content-type': 'image/jpeg' } });
    if (!res.ok) throw new Error(`S3 seed upload failed: ${res.status}`);
  }
  await q(
    `INSERT INTO complaint_media (owner_id, device_id, complaint_id, stage, kind, status, content_type, declared_bytes, declared_sha256,
                                  object_key, thumb_key, stored_content_type, bytes_stored, width, height, captured_at, location, gps_accuracy_m,
                                  scan_status, distance_m, outside_geofence, confirmed_at, processed_at, attached_at)
     VALUES ($1, $2, $3, 'COMPLAINT', 'PHOTO', 'READY', 'image/jpeg', $4, $5, $6, $7, 'image/jpeg',
             $4, 640, 480, now() - interval '50 hours', ST_SetSRID(ST_MakePoint(80.005, 25.005), 4326), 5, 'SKIPPED', 3, false, now(), now(), now())`,
    [users.citizen.id, device.id, complaints.assigned.id, jpeg.length, randomBytes(32).toString('hex'), photoKey, thumbKey],
  );
  await q(`INSERT INTO complaint_seq (ulb_id, year, last_value) VALUES ($1, $2, 100), ($3, $2, 100)`, [ulbA.id, new Date().getFullYear(), ulbB.id]);
  await db.end();

  mkdirSync(join(here, '.auth'), { recursive: true });
  writeFileSync(join(here, '.auth/fixtures.json'), JSON.stringify({
    users, complaints, ulbs: { A: ulbA.id, B: ulbB.id }, wards: { A1: wA1, A2: wA2, B1: wB1 }, areaId: area.id, districtId: district.id,
  }, null, 2));
}

await ensureS3();
ensureRedis();
await resetDatabase();
await seed();
process.stdout.write('e2e environment ready\n');
