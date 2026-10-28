import { db, closeDb } from '@/db/connection';
import { one, query, run } from '@/db/sql';
import { blindIndex, encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import { hashPassword } from '@/lib/password';
import { square } from '@/lib/geo';
import { NOTICE_VERSION, CONSENT_PURPOSE } from '@/lib/notice';
import type { Role } from '@/lib/enums';
import { resetRateLimitsForTests } from '@/middleware/rateLimit';
import { setMailSender } from '@/lib/mail';
import { UserModel } from '@/models/UserModel';
import { afterAll, beforeEach } from 'vitest';

export const PASSWORD = 'Swachh#Test2026';
export const BASE = 'http://localhost:3000';

type RouteFn = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;

export interface CallOptions {
  body?: unknown;
  rawBody?: string;
  token?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  query?: Record<string, string | number>;
  params?: Record<string, string>;
}

export interface Reply<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  status: number;
  body: T;
  headers: Headers;
  cookies: string[];
}

/** Calls a route handler exactly as Next.js would, without starting a server. */
export async function call<T = any>(fn: RouteFn, method: string, path: string, o: CallOptions = {}): Promise<Reply<T>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, String(v));
  const headers = new Headers(o.headers ?? {});
  if (!headers.has('host')) headers.set('host', new URL(BASE).host); // a real request always carries Host
  if (o.token) headers.set('authorization', `Bearer ${o.token}`);
  if (o.cookies) headers.set('cookie', Object.entries(o.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '));
  let body: string | undefined;
  if (o.rawBody !== undefined) body = o.rawBody;
  else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  const res = await fn(new Request(url, { method, headers, body }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON (exports, errors from the framework): keep the text
  }
  return { status: res.status, body: parsed as T, headers: res.headers, cookies: res.headers.getSetCookie() };
}

/** Browser-style call: cookies plus the CSRF header and a same-origin Origin. */
export const browser = (cookies: Record<string, string>): Pick<CallOptions, 'cookies' | 'headers'> => ({
  cookies,
  headers: { 'x-cwm-csrf': '1', origin: BASE },
});

export function cookieJar(reply: Reply): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const c of reply.cookies) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const value = decodeURIComponent(pair.slice(i + 1));
    if (value) jar[pair.slice(0, i)] = value;
  }
  return jar;
}

let mobileCounter = 0;
export function uniqueMobile(): string {
  mobileCounter += 1;
  const tail = (Date.now() % 100_000_000) * 10 + (mobileCounter % 10);
  return `9${String(tail).padStart(9, '0').slice(-9)}`;
}

export interface Jurisdiction {
  districtId: string;
  ulbId: string;
  districtLgd: number;
  ulbLgd: number;
  /** Two adjacent 0.01 degree wards; ward 0 has an area, ward 1 has none (complaints wait for the Sub Admin). */
  wards: { id: string; number: number; center: { lat: number; lng: number } }[];
  areaId: string;
}

/** A district, a ULB and two adjacent wards in a map region no other test file uses. */
export async function createJurisdiction(): Promise<Jurisdiction> {
  const r = await run(db(), 'INSERT INTO test_region_seq VALUES ()');
  const n = r.insertId;
  const lat = 10 + Math.floor(n / 50) * 0.1;
  const lng = 70 + (n % 50) * 0.1;
  const districtLgd = 1000 + n;
  const ulbLgd = 800000 + n;
  const districtId = newId();
  const ulbId = newId();
  await run(db(), `INSERT INTO districts (id, lgd_code, name) VALUES (?,?,?)`, [districtId, districtLgd, `District ${n}`]);
  await run(db(), `INSERT INTO ulbs (id, district_id, lgd_code, type, name) VALUES (?,?,?, 'NAGAR_NIGAM', ?)`, [ulbId, districtId, ulbLgd, `Nagar Nigam ${n}`]);
  const wards = [];
  for (const [i, wLng] of [lng, lng + 0.01].entries()) {
    const id = newId();
    await run(db(), `INSERT INTO wards (id, ulb_id, number) VALUES (?,?,?)`, [id, ulbId, i + 1]);
    await run(db(), `INSERT INTO ward_boundaries (ward_id, geom) VALUES (?, ST_GeomFromGeoJSON(?, 1, 4326))`, [id, JSON.stringify(square(lat, wLng))]);
    wards.push({ id, number: i + 1, center: { lat: lat + 0.005, lng: wLng + 0.005 } });
  }
  const areaId = newId();
  await run(db(), `INSERT INTO areas (id, ulb_id, name) VALUES (?,?, 'Area A')`, [areaId, ulbId]);
  await run(db(), `UPDATE wards SET area_id = ? WHERE id = ?`, [areaId, wards[0].id]);
  return { districtId, ulbId, districtLgd, ulbLgd, wards, areaId };
}

export interface TestUser {
  id: string;
  role: Role;
  mobile: string;
  email: string;
  password: string;
}

export async function createUser(
  role: Role,
  j?: Jurisdiction,
  opts: { mustChangePassword?: boolean; consent?: boolean; status?: 'ACTIVE' | 'DISABLED' } = {},
): Promise<TestUser> {
  const mobile = uniqueMobile();
  const email = `u${mobile}@example.gov.in`;
  const id = newId();
  const citizen = role === 'CITIZEN';
  await UserModel.insert(db(), {
    id, role, status: opts.status ?? 'ACTIVE', name: `Test ${role}`, mobileEnc: encrypt(mobile), mobileHash: blindIndex(mobile),
    emailEnc: encrypt(email), emailHash: blindIndex(email), passwordHash: await hashPassword(PASSWORD),
    mustChangePassword: opts.mustChangePassword ?? false,
    districtId: role === 'WEB_ADMIN' || citizen ? null : j!.districtId,
    ulbId: ['SUB_ADMIN', 'SUPERVISOR', 'WORKER'].includes(role) ? j!.ulbId : null,
    homeDistrictId: citizen ? j!.districtId : null,
    homeUlbId: citizen ? j!.ulbId : null,
    homeWardId: citizen ? j!.wards[0].id : null,
  });
  // Registration records consent in the same transaction; a citizen without it only exists after a notice change.
  if (citizen && (opts.consent ?? true)) {
    await run(db(), `INSERT INTO consents (id, user_id, purpose, notice_version, language) VALUES (?,?,?,?, 'en')`, [newId(), id, CONSENT_PURPOSE, NOTICE_VERSION]);
  }
  return { id, role, mobile, email, password: PASSWORD };
}

/** Captures outgoing mail for the current test. */
export function captureMail() {
  const sent: { to: string; subject: string; text: string }[] = [];
  setMailSender(async (m) => void sent.push(m));
  return sent;
}

export { db, one, query, run };

/** Common hooks: clear rate limits and mail between tests, close the pool at the end of the file. */
export function useTestEnvironment() {
  beforeEach(() => {
    resetRateLimitsForTests();
    setMailSender(undefined);
  });
  afterAll(async () => {
    await closeDb();
  });
}
