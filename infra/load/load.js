// k6 load test: "10× daily volume in one hour" (docs/PLAN.md §6).
// Plan sizing: 1,000 complaints/day → 10,000 in one hour ≈ 2.8 complaints/s, each with an in-app
// photo, plus field work (start + resolve with photos) at the same pace, citizens browsing, and
// officials refreshing dashboards. Every capture is a real JPEG, uniquely modified, signed with
// a per-install P-256 key exactly like the apps do, so the server runs its full media checks.
//
//   node prepare.mjs && (start the API with env.mjs) && k6 run load.js
//   RATE=2.8 HOLD=10m k6 run load.js       (defaults)
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import encoding from 'k6/encoding';
import { hmac, sha256 } from 'k6/crypto';
import { Counter } from 'k6/metrics';

const filed = new Counter('complaints_filed');
const resolvedCount = new Counter('complaints_resolved');

const F = JSON.parse(open('./fixtures.json'));
const PHOTO = new Uint8Array(open('./photo.jpg', 'b'));
const BASE = __ENV.API || 'http://127.0.0.1:3300/api/v1';
const RATE = Number(__ENV.RATE || 2.8);
const RAMP = __ENV.RAMP || '1m';
const HOLD = __ENV.HOLD || '10m';
const MAX_VUS = 300;
const PER_CITIZEN = 9; // stays under the 10 complaints / citizen / day limit
const toSec = (d) => Number(d.slice(0, -1)) * (d.endsWith('m') ? 60 : 1);
const TOTAL = `${toSec(RAMP) + toSec(HOLD)}s`;
const JSONH = { 'Content-Type': 'application/json' };
const CONFLICT_OK = http.expectedStatuses({ min: 200, max: 299 }, 409);

export const options = {
  scenarios: {
    citizens: {
      // k6 rates are integers per timeUnit: 2.8/s = 168/min.
      executor: 'ramping-arrival-rate', exec: 'citizen', timeUnit: '1m', startRate: 0, preAllocatedVUs: 40, maxVUs: MAX_VUS,
      stages: [{ target: Math.round(RATE * 60), duration: RAMP }, { target: Math.round(RATE * 60), duration: HOLD }],
    },
    // One single-VU scenario per supervisor and per worker: k6 has no per-scenario VU index, and two
    // VUs playing the same person would race each other (an earlier run left areas unattended).
    ...Object.fromEntries(F.supervisors.map((_, i) => [`supervisor_${i}`, { executor: 'constant-vus', exec: 'supervisor', vus: 1, duration: TOTAL, env: { WHO: String(i) } }])),
    ...Object.fromEntries(F.workers.map((_, i) => [`worker_${i}`, { executor: 'constant-vus', exec: 'worker', vus: 1, duration: TOTAL, env: { WHO: String(i) } }])),
    // One VU: it owns the Sub Admin's refresh token (sharing a rotating token would trip reuse detection).
    dashboards: { executor: 'constant-arrival-rate', exec: 'dashboard', rate: 1, timeUnit: '2s', duration: TOTAL, preAllocatedVUs: 1, maxVUs: 1 },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{name:complaint-create}': ['p(95)<1500'],
    'http_req_duration{name:confirm}': ['p(95)<3000'],
    'http_req_duration{name:upload-url}': ['p(95)<800'],
    'http_req_duration{name:list}': ['p(95)<800'],
    'http_req_duration{name:login}': ['p(95)<1500'],
    'http_req_duration{name:report}': ['p(95)<2500'],
    'http_req_duration{name:start}': ['p(95)<1500'],
    'http_req_duration{name:resolve}': ['p(95)<1500'],
    'http_req_duration{name:assign}': ['p(95)<800'],
    'http_req_duration{name:device}': ['p(95)<800'],
    // Storage is moto here (a Python emulator); recorded for information, S3 itself is not under test.
    'http_req_duration{name:storage-put}': ['max>=0'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ---------- helpers ----------
const auth = (s) => ({ headers: { ...JSONH, Authorization: `Bearer ${s.token}` } });
const post = (path, body, s, name, extra = {}) => http.post(`${BASE}${path}`, JSON.stringify(body), { ...(s ? auth(s) : { headers: JSONH }), tags: { name }, ...extra });
const get = (path, s, name) => http.get(`${BASE}${path}`, { ...auth(s), tags: { name } });

/** ECDSA raw (r||s) → DER, as Android Keystore produces. */
function der(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.slice(i);
    return b[0] & 0x80 ? [0x02, b.length + 1, 0, ...b] : [0x02, b.length, ...b];
  };
  const r = int(Array.from(raw.slice(0, 32)));
  const s = int(Array.from(raw.slice(32)));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

/** A unique copy of the photo: a 16-byte JPEG comment after SOI (still a valid image). */
function uniquePhoto() {
  const out = new Uint8Array(PHOTO.length + 20);
  out.set([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x12]);
  for (let i = 0; i < 16; i++) out[6 + i] = (Math.random() * 256) | 0;
  out.set(PHOTO.subarray(2), 22);
  return out;
}

async function newDevice(s) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  const r = post('/devices', { publicKey: encoding.b64encode(spki), platform: 'ANDROID', appVersion: 'load-1' }, s, 'device');
  check(r, { 'device registered': (x) => x.status === 201 });
  s.deviceId = r.json('id');
  s.key = kp.privateKey;
}

/** In-app capture → upload → signed confirm. Returns the media id or null. */
async function capture(s, lat, lng) {
  const bytes = uniquePhoto();
  const hash = sha256(bytes.buffer, 'hex');
  const u = post('/media/upload-url', { deviceId: s.deviceId, kind: 'PHOTO', contentType: 'image/jpeg', bytes: bytes.length, sha256: hash }, s, 'upload-url');
  if (!check(u, { 'upload-url 201': (x) => x.status === 201 })) return null;
  const { mediaId, uploadUrl, headers } = u.json();
  const put = http.put(uploadUrl, bytes.buffer, { headers, tags: { name: 'storage-put' } });
  if (!check(put, { 'storage PUT 200': (x) => x.status === 200 })) return null;
  const manifest = JSON.stringify({
    v: 1, mediaId, deviceId: s.deviceId, kind: 'PHOTO', sha256: hash, capturedAt: new Date().toISOString(),
    lat, lng, accuracyM: 6 + Math.random() * 10, isMockLocation: false,
  });
  const mBytes = new Uint8Array(manifest.length);
  for (let i = 0; i < manifest.length; i++) mBytes[i] = manifest.charCodeAt(i); // ASCII-only JSON
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, s.key, mBytes));
  const c = post(`/media/${mediaId}/confirm`, { manifest: encoding.b64encode(mBytes.buffer, 'rawurl'), signature: encoding.b64encode(der(sig).buffer) }, s, 'confirm');
  return check(c, { 'confirm READY': (x) => x.status === 200 && x.json('status') === 'READY' }) ? mediaId : null;
}

function login(mobile, name = 'login') {
  const r = post('/auth/login', { identifier: mobile, password: F.password }, null, name);
  check(r, { 'login ok': (x) => x.status === 200 });
  return { token: r.json('accessToken'), refresh: r.json('refreshToken'), at: Date.now() };
}

// TOTP (RFC 6238, SHA-1, 30 s) for the Sub Admin's dashboard session.
function totp(secret) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret) bits += alpha.indexOf(ch).toString(2).padStart(5, '0');
  const key = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = new Uint8Array(8);
  let t = Math.floor(Date.now() / 30000);
  for (let i = 7; i >= 0; i--) { counter[i] = t & 0xff; t = Math.floor(t / 256); }
  const h = new Uint8Array(hmac('sha1', key.buffer, counter.buffer, 'binary'));
  const o = h[19] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

export function setup() {
  const sa = post('/auth/login', { identifier: F.subAdmin.mobile, password: F.password }, null, 'setup');
  const v = post('/auth/mfa/verify', { mfaToken: sa.json('mfaToken'), code: totp(F.subAdmin.mfaSecret) }, null, 'setup');
  if (v.status !== 200) throw new Error(`Sub Admin MFA failed: ${v.status} ${v.body}`);
  return { dashboard: { token: v.json('accessToken'), refresh: v.json('refreshToken') } };
}

// ---------- citizens: report a problem with a photo, then look at "my complaints" ----------
const me = {};
export async function citizen() {
  const k = Math.floor(exec.vu.iterationInScenario / PER_CITIZEN);
  const idx = ((exec.vu.idInTest - 1) + k * MAX_VUS) % F.citizens.length;
  if (me.idx !== idx || Date.now() - me.at > 13 * 60_000) {
    Object.assign(me, login(F.citizens[idx]), { idx });
    await newDevice(me);
  }
  const w = F.wards[(Math.random() * F.wards.length) | 0];
  const lat = w.lat + 0.001 + Math.random() * 0.008;
  const lng = w.lng + 0.001 + Math.random() * 0.008;
  const mediaId = await capture(me, lat, lng);
  if (!mediaId) return sleep(1); // never hot-loop on a refusal (an earlier soak did, 175 req/s of 429s)
  const c = post('/complaints', { typeId: F.typeId, lat, lng, gpsAccuracyM: 8, landmark: 'Near the market', description: 'Garbage heap not lifted for two days', mediaIds: [mediaId] }, me, 'complaint-create');
  if (check(c, { 'complaint filed': (x) => x.status === 201 })) filed.add(1);
  check(get('/complaints?pageSize=20', me, 'list'), { 'my complaints 200': (x) => x.status === 200 });
  get('/notifications/unread-count', me, 'list');
}

// ---------- supervisors: assign new complaints in their area ----------
const sup = {};
export function supervisor() {
  if (!sup.token || Date.now() - sup.at > 13 * 60_000) {
    Object.assign(sup, login(F.supervisors[Number(__ENV.WHO)].mobile));
  }
  const r = get('/complaints?status=ASSIGNED&pageSize=50', sup, 'list');
  const fresh = (r.json('items') || []).filter((c) => !c.worker);
  for (const c of fresh) {
    const wk = F.workers[(Math.random() * F.workers.length) | 0];
    const a = post(`/complaints/${c.id}/assign`, { workerId: wk.id }, sup, 'assign', { responseCallback: CONFLICT_OK });
    check(a, { 'assigned': (x) => x.status === 201 || x.status === 409 });
  }
  sleep(fresh.length ? 1 : 3);
}

// ---------- field workers: start with a photo, clean, resolve with a photo ----------
const wk = {};
export async function worker() {
  if (!wk.token || Date.now() - wk.at > 13 * 60_000) {
    Object.assign(wk, login(F.workers[Number(__ENV.WHO)].mobile));
    await newDevice(wk);
  }
  const r = get('/complaints?status=ASSIGNED&pageSize=5', wk, 'list');
  const task = (r.json('items') || [])[0];
  if (!task) return sleep(3);
  const { lat, lng } = task.location;
  const before = await capture(wk, lat + 0.00005, lng);
  if (!before) return sleep(2);
  const s = post(`/complaints/${task.id}/start`, { mediaIds: [before], location: { lat, lng, accuracyM: 7 } }, wk, 'start', { responseCallback: CONFLICT_OK });
  if (s.status === 409) return; // reassigned or already started meanwhile
  check(s, { 'work started': (x) => x.status === 201 });
  sleep(2 + Math.random() * 3); // the actual cleaning, compressed
  const after = await capture(wk, lat, lng + 0.00005);
  if (!after) return sleep(2);
  const z = post(`/complaints/${task.id}/resolve`, { remark: 'Heap cleared and area swept', mediaIds: [after], location: { lat, lng, accuracyM: 7 } }, wk, 'resolve', { responseCallback: CONFLICT_OK });
  check(z, { 'resolved': (x) => x.status === 201 || x.status === 409 });
  if (z.status === 201) resolvedCount.add(1);
  sleep(1);
}

// ---------- officials: dashboard refreshes ----------
const dash = {};
export function dashboard(data) {
  if (!dash.token) Object.assign(dash, data.dashboard, { at: Date.now() });
  if (Date.now() - dash.at > 13 * 60_000) {
    // Long runs outlive the 15-minute access token: rotate like the portal does.
    const r = post('/auth/refresh', { refreshToken: dash.refresh }, null, 'refresh');
    check(r, { 'refresh ok': (x) => x.status === 200 });
    Object.assign(dash, { token: r.json('accessToken'), refresh: r.json('refreshToken'), at: Date.now() });
  }
  const s = dash;
  for (const p of ['/reports/summary', '/reports/trend', '/reports/ageing?groupBy=ward', '/reports/breakdown?by=ward', '/reports/hotspots']) {
    check(get(p, s, 'report'), { 'report 200': (x) => x.status === 200 });
  }
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    'results/summary.json': JSON.stringify(data, null, 1),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const line = (name) => {
    const k = `http_req_duration{name:${name}}`;
    const v = m[k]?.values;
    return v ? `  ${name.padEnd(17)} p50 ${v.med.toFixed(0).padStart(5)} ms  p95 ${v['p(95)'].toFixed(0).padStart(5)} ms  p99 ${v['p(99)'].toFixed(0).padStart(5)} ms  max ${v.max.toFixed(0).padStart(6)} ms` : `  ${name}: no data`;
  };
  const thresholds = Object.entries(m).flatMap(([k, v]) => Object.entries(v.thresholds || {}).map(([t, r]) => `  ${r.ok ? 'PASS' : 'FAIL'} ${k} ${t}`));
  return [
    `complaints filed ${m.complaints_filed?.values.count ?? 0} (${(m.complaints_filed?.values.rate ?? 0).toFixed(2)}/s)  resolved ${m.complaints_resolved?.values.count ?? 0}  http requests ${m.http_reqs.values.count} (${m.http_reqs.values.rate.toFixed(1)}/s)  failed ${(m.http_req_failed.values.rate * 100).toFixed(2)}%  checks ${(m.checks.values.rate * 100).toFixed(2)}%`,
    'latency by endpoint:',
    ...['login', 'device', 'upload-url', 'storage-put', 'confirm', 'complaint-create', 'list', 'assign', 'start', 'resolve', 'report'].map(line),
    'thresholds:',
    ...thresholds,
    '',
  ].join('\n');
}
