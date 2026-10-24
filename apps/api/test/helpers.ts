import './test-env';
import { createHash, generateKeyPairSync, KeyObject, randomBytes, sign as signData } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { API_PREFIX, configureApp } from '../src/app.setup';
import { PiiCryptoService } from '../src/common/crypto/pii-crypto.service';
import { Role } from '../src/common/enums';
import { APP_CONFIG, AppConfig } from '../src/config/configuration';
import { ARGON2_OPTIONS } from '../src/modules/auth/auth.service';
import { MAIL_SERVICE, MailService } from '../src/modules/auth/mail.service';

export const PASSWORD = 'Swachh#2026city';

export class CapturingMail implements MailService {
  sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string) {
    this.sent.push({ to, subject, text });
  }
  lastTokenFor(to: string): string | undefined {
    const mail = [...this.sent].reverse().find((m) => m.to === to);
    return mail?.text.match(/token=([^\s&]+)/)?.[1];
  }
}

export interface TestCtx {
  app: INestApplication;
  ds: DataSource;
  pii: PiiCryptoService;
  mail: CapturingMail;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(): Promise<TestCtx> {
  const mail = new CapturingMail();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_SERVICE)
    .useValue(mail)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, app.get<AppConfig>(APP_CONFIG));
  // Listen once: otherwise supertest opens/closes the shared server per request, which races
  // when a request is built before an awaited call that issues other requests.
  await app.listen(0, '127.0.0.1');
  return { app, ds: app.get(DataSource), pii: app.get(PiiCryptoService), mail, http: () => request(app.getHttpServer()) };
}

export const api = (path: string) => `/${API_PREFIX}${path}`;

let mobileCounter = 0;
/** Unique valid Indian mobile per call (process id keeps parallel runs apart). */
export function uniqueMobile(): string {
  mobileCounter += 1;
  const n = (process.pid % 1000) * 100000 + mobileCounter + Math.floor(Math.random() * 1000) * 100;
  return `9${String(n % 1_000_000_000).padStart(9, '0')}`;
}

/** Square polygon of `size` degrees with its south-west corner at (lat, lng). */
export function square(lat: number, lng: number, size = 0.01) {
  return {
    type: 'Polygon' as const,
    coordinates: [[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]],
  };
}

export interface Jurisdiction {
  districtId: string;
  districtLgd: number;
  ulbId: string;
  ulbLgd: number;
  /** ward1 is in an area with a supervisor slot; ward2 has no area (complaints wait for the Sub Admin). */
  wards: { id: string; number: number; center: { lat: number; lng: number } }[];
  areaId: string;
}

/**
 * Creates a district, a ULB and two adjacent 0.01° wards in a region no other
 * test uses (so GPS point-in-polygon lookups never collide across test files).
 */
export async function createJurisdiction(ds: DataSource): Promise<Jurisdiction> {
  const [{ n }] = await ds.query(`SELECT nextval('test_region_seq')::int AS n`);
  const lat = 10 + Math.floor(n / 50) * 0.1;
  const lng = 70 + (n % 50) * 0.1;
  const districtLgd = 1000 + n;
  const ulbLgd = 800000 + n;
  const [d] = await ds.query(`INSERT INTO districts (lgd_code, name) VALUES ($1, $2) RETURNING id`, [districtLgd, `District ${n}`]);
  const [u] = await ds.query(
    `INSERT INTO ulbs (district_id, lgd_code, type, name) VALUES ($1, $2, 'NAGAR_NIGAM', $3) RETURNING id`,
    [d.id, ulbLgd, `Nagar Nigam ${n}`],
  );
  const wards = [];
  for (const [i, wLng] of [lng, lng + 0.01].entries()) {
    const [w] = await ds.query(
      `INSERT INTO wards (ulb_id, number, geom) VALUES ($1, $2, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))) RETURNING id`,
      [u.id, i + 1, JSON.stringify(square(lat, wLng))],
    );
    wards.push({ id: w.id, number: i + 1, center: { lat: lat + 0.005, lng: wLng + 0.005 } });
  }
  const [a] = await ds.query(`INSERT INTO areas (ulb_id, name) VALUES ($1, 'Area A') RETURNING id`, [u.id]);
  await ds.query(`UPDATE wards SET area_id = $1 WHERE id = $2`, [a.id, wards[0].id]);
  return { districtId: d.id, districtLgd, ulbId: u.id, ulbLgd, wards, areaId: a.id };
}

export interface TestUser {
  id: string;
  role: Role;
  mobile: string;
  email: string;
  password: string;
  mfaSecret?: string;
}

export async function createUser(
  ctx: TestCtx,
  role: Role,
  j?: Jurisdiction,
  opts: { mustChangePassword?: boolean; mfa?: boolean } = {},
): Promise<TestUser> {
  const mobile = uniqueMobile();
  const email = `u${mobile}@example.gov.in`;
  const mfaSecret = (opts.mfa ?? [Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN].includes(role))
    ? authenticator.generateSecret(20)
    : undefined;
  const isCitizen = role === Role.CITIZEN;
  const [row] = await ctx.ds.query(
    `INSERT INTO users (role, status, name, mobile_enc, mobile_hash, email_enc, email_hash, password_hash,
                        must_change_password, mfa_enabled, mfa_secret_enc, district_id, ulb_id,
                        home_district_id, home_ulb_id, home_ward_id)
     VALUES ($1, 'ACTIVE', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [
      role, `Test ${role}`, ctx.pii.encrypt(mobile), ctx.pii.blindIndex(mobile), ctx.pii.encrypt(email), ctx.pii.blindIndex(email),
      await argon2.hash(PASSWORD, ARGON2_OPTIONS), opts.mustChangePassword ?? false, !!mfaSecret,
      mfaSecret ? ctx.pii.encrypt(mfaSecret) : null,
      role === Role.WEB_ADMIN || isCitizen ? null : j!.districtId,
      [Role.SUB_ADMIN, Role.SUPERVISOR, Role.WORKER].includes(role) ? j!.ulbId : null,
      isCitizen ? j!.districtId : null, isCitizen ? j!.ulbId : null, isCitizen ? j!.wards[0].id : null,
    ],
  );
  return { id: row.id, role, mobile, email, password: PASSWORD, mfaSecret };
}

/** Logs in through the real API (including the TOTP step for admins) and returns the session. */
export async function login(ctx: TestCtx, user: TestUser): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await ctx.http().post(api('/auth/login')).send({ identifier: user.mobile, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (res.body.status === 'OK') return res.body;
  if (res.body.status !== 'MFA_REQUIRED') throw new Error(`unexpected login state ${res.body.status}`);
  // Each TOTP step can be used once; tests log the same admin in repeatedly, so clear the replay marker.
  await ctx.ds.query(`UPDATE users SET mfa_last_step = NULL WHERE id = $1`, [user.id]);
  const v = await ctx.http().post(api('/auth/mfa/verify')).send({ mfaToken: res.body.mfaToken, code: authenticator.generate(user.mfaSecret!) });
  if (v.status !== 200) throw new Error(`mfa failed: ${v.status} ${JSON.stringify(v.body)}`);
  return v.body;
}

export async function tokenFor(ctx: TestCtx, user: TestUser): Promise<string> {
  return (await login(ctx, user)).accessToken;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// Media helpers: simulate the app's device key and signed in-app capture.
// ---------------------------------------------------------------------------

export const subOf = (token: string): string => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;

export class TestDevice {
  constructor(readonly id: string, readonly privateKey: KeyObject, readonly publicKeyB64: string) {}

  static async register(ctx: TestCtx, token: string): Promise<TestDevice> {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const res = await ctx.http().post(api('/devices')).set(bearer(token)).send({ publicKey: spki, platform: 'ANDROID', appVersion: '1.0.0' });
    if (res.status !== 201) throw new Error(`device registration failed: ${res.status} ${JSON.stringify(res.body)}`);
    return new TestDevice(res.body.id, privateKey, spki);
  }

  sign(manifest: object, key: KeyObject = this.privateKey) {
    const encoded = Buffer.from(JSON.stringify(manifest)).toString('base64url');
    return { manifest: encoded, signature: signData('sha256', Buffer.from(encoded, 'base64url'), key).toString('base64') };
  }
}

export const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export interface CaptureOptions {
  kind?: 'PHOTO' | 'VIDEO';
  contentType?: string;
  location?: { lat: number; lng: number };
  accuracyM?: number;
  capturedAt?: Date;
  isMockLocation?: boolean;
  /** Bytes actually PUT to storage (defaults to the declared file). */
  uploadBody?: Buffer;
  /** Edit the manifest before it is signed. */
  manifest?: (m: Record<string, unknown>) => Record<string, unknown>;
  /** Replace the signature entirely. */
  signature?: string;
}

/** Full app flow: request upload URL → PUT to storage → confirm with signed manifest. */
export async function capture(ctx: TestCtx, token: string, device: TestDevice, file: Buffer, o: CaptureOptions = {}) {
  const kind = o.kind ?? 'PHOTO';
  const contentType = o.contentType ?? (kind === 'PHOTO' ? 'image/jpeg' : 'video/mp4');
  const sha = sha256hex(file);
  const up = await ctx.http().post(api('/media/upload-url')).set(bearer(token))
    .send({ deviceId: device.id, kind, contentType, bytes: file.length, sha256: sha });
  if (up.status !== 201) return { upload: up, confirm: undefined, mediaId: undefined as unknown as string };
  const body = o.uploadBody ?? file;
  const put = await fetch(up.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body });
  if (!put.ok) throw new Error(`storage PUT failed: ${put.status} ${await put.text()}`);
  let manifest: Record<string, unknown> = {
    v: 1, mediaId: up.body.mediaId, deviceId: device.id, kind, sha256: sha,
    capturedAt: (o.capturedAt ?? new Date()).toISOString(),
    lat: o.location?.lat ?? 21.25, lng: o.location?.lng ?? 81.63, accuracyM: o.accuracyM ?? 6,
    isMockLocation: o.isMockLocation ?? false,
  };
  if (o.manifest) manifest = o.manifest(manifest);
  const signed = device.sign(manifest);
  const confirm = await ctx.http().post(api(`/media/${up.body.mediaId}/confirm`)).set(bearer(token))
    .send({ manifest: signed.manifest, signature: o.signature ?? signed.signature });
  return { upload: up, confirm, mediaId: up.body.mediaId as string };
}

/**
 * Fast fixture for tests that are not about the media pipeline: inserts an already-verified
 * READY photo owned by the user. The real pipeline is covered by media.e2e and security/media.
 */
export async function quickMedia(ctx: TestCtx, userId: string, location?: { lat: number; lng: number }): Promise<string> {
  const fp = randomBytes(32).toString('hex');
  const [d] = await ctx.ds.query(
    `INSERT INTO devices (user_id, public_key, key_fingerprint, platform) VALUES ($1, 'fixture', $2, 'ANDROID') RETURNING id`,
    [userId, fp],
  );
  const [m] = await ctx.ds.query(
    `INSERT INTO complaint_media (owner_id, device_id, kind, status, content_type, declared_bytes, declared_sha256,
                                  object_key, thumb_key, captured_at, location, gps_accuracy_m, scan_status, confirmed_at, processed_at)
     VALUES ($1, $2, 'PHOTO', 'READY', 'image/jpeg', 1000, $3, 'fixture.jpg', 'fixture.thumb.jpg', now(),
             ST_SetSRID(ST_MakePoint($5, $4), 4326), 5, 'SKIPPED', now(), now())
     RETURNING id`,
    [userId, d.id, randomBytes(32).toString('hex'), location?.lat ?? 21.25, location?.lng ?? 81.63],
  );
  return m.id;
}
