import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { GET as listDevices, POST as registerDevice } from '@/app/api/v1/devices/route';
import { DELETE as revokeDevice } from '@/app/api/v1/devices/[id]/route';
import { POST as createUpload } from '@/app/api/v1/media/upload-url/route';
import { PUT as putContent } from '@/app/api/v1/media/[id]/content/route';
import { POST as confirmRoute } from '@/app/api/v1/media/[id]/confirm/route';
import { GET as getMedia } from '@/app/api/v1/media/[id]/route';
import { GET as fileRoute } from '@/app/api/v1/media/[id]/file/route';
import { JobRunner } from '@/jobs/runner';
import { resetConfigForTests } from '@/config/env';
import { newId } from '@/lib/ids';
import { FILE_URL_TTL_SECONDS, signedFileUrl } from '@/lib/signedUrl';
import { Storage } from '@/lib/storage';
import { MediaService } from '@/services/MediaService';
import { call, createJurisdiction, createUser, db, loginAs, one, query, run, setupTestEnvironment, type Jurisdiction } from './helpers';
import { hasTool, makeDevice, makeJpeg, makeMp4, makeWebp, newKeyPair, sha256, signManifest, uploadMedia } from './media-helpers';

setupTestEnvironment();

let j: Jurisdiction;
let citizen: string;
let device: Awaited<ReturnType<typeof makeDevice>>;
const FFMPEG = hasTool('ffmpeg') && hasTool('ffprobe');

beforeAll(async () => {
  j = await createJurisdiction();
});
beforeEach(async () => {
  citizen = await loginAs(await createUser('CITIZEN', j));
  device = await makeDevice(citizen);
  await run(db(), 'DELETE FROM jobs');
});
afterEach(() => {
  vi.useRealTimers(); // a failing test must not leave the clock faked for the next one
  vi.restoreAllMocks();
  delete process.env.FFMPEG_PATH;
  delete process.env.FFPROBE_PATH;
  resetConfigForTests();
});

const row = (id: string) => one(db(), `SELECT * FROM complaint_media WHERE id = ?`, [id]);
const origin = 'http://localhost:3000';
const fileCall = (url: string, headers: Record<string, string> = {}) => {
  const u = new URL(url);
  const id = u.pathname.split('/')[4];
  return call(fileRoute, 'GET', u.pathname + u.search, { params: { id }, headers });
};
async function runVideoJobs() {
  const runner = new JobRunner().register('video', 'transcode', (p, job) => MediaService.processVideoJob(p.mediaId, job));
  return runner.runDue({ queues: ['video'] });
}

describe('device keys', () => {
  it('registers an EC P-256 key once per install and returns the same id when asked again', async () => {
    const again = await call(registerDevice, 'POST', '/x', { token: citizen, body: { publicKey: device.publicKey, platform: 'ANDROID', appVersion: '1.0.1' } });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(device.id);
    const list = await call(listDevices, 'GET', '/x', { token: citizen });
    expect(list.body).toEqual([expect.objectContaining({ id: device.id, platform: 'ANDROID', appVersion: '1.0.1', integrityVerdict: 'UNVERIFIED' })]);
    expect(JSON.stringify(list.body)).not.toContain(device.publicKey);
  });

  it('refuses keys that are not EC P-256, are not base64, or belong to another account', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    for (const publicKey of [rsa, p384, Buffer.from('not a key at all').toString('base64'), 'not base64!!', '']) {
      expect((await call(registerDevice, 'POST', '/x', { token: citizen, body: { publicKey, platform: 'ANDROID' } })).status, publicKey.slice(0, 20)).toBe(400);
    }
    const other = await loginAs(await createUser('CITIZEN', j));
    expect((await call(registerDevice, 'POST', '/x', { token: other, body: { publicKey: device.publicKey, platform: 'ANDROID' } })).status).toBe(409);
    expect((await call(registerDevice, 'POST', '/x', { token: citizen, body: { publicKey: newKeyPair().publicKey, platform: 'ANDROID', userId: 'x' } })).status).toBe(400);
  });

  it('keeps only the 5 most recent installs active', async () => {
    const keys = [];
    for (let i = 0; i < 5; i++) {
      keys.push(await makeDevice(citizen));
      await run(db(), `UPDATE devices SET last_used_at = DATE_ADD(NOW(3), INTERVAL ? SECOND) WHERE id = ?`, [i + 1, keys[i].id]);
    }
    expect((await call(listDevices, 'GET', '/x', { token: citizen })).body).toHaveLength(5);
    const retired = await query<{ id: string }>(db(), `SELECT id FROM devices WHERE user_id = (SELECT user_id FROM devices WHERE id = ?) AND revoked_at IS NOT NULL`, [device.id]);
    expect(retired).toEqual([{ id: device.id }]); // exactly one, and it is the oldest install
  });

  it('revokes only your own device; a revoked device can no longer start uploads', async () => {
    const other = await loginAs(await createUser('CITIZEN', j));
    expect((await call(revokeDevice, 'DELETE', '/x', { token: other, params: { id: device.id } })).status).toBe(404);
    expect((await call(revokeDevice, 'DELETE', '/x', { token: citizen, params: { id: device.id } })).status).toBe(204);
    expect((await call(revokeDevice, 'DELETE', '/x', { token: citizen, params: { id: device.id } })).status).toBe(404);
    const r = await uploadMedia(citizen, device, await makeJpeg());
    expect(r.declared.status).toBe(400);
  });

  it('is for the app roles only, and works before the privacy notice is accepted', async () => {
    const roles = ['WEB_ADMIN', 'DISTRICT_ADMIN'] as const;
    for (const role of roles) {
      const t = await loginAs(await createUser(role, j));
      expect((await call(registerDevice, 'POST', '/x', { token: t, body: { publicKey: newKeyPair().publicKey, platform: 'ANDROID' } })).status, role).toBe(403);
    }
    const noConsent = await loginAs(await createUser('CITIZEN', j, { consent: false }));
    expect((await call(registerDevice, 'POST', '/x', { token: noConsent, body: { publicKey: newKeyPair().publicKey, platform: 'ANDROID' } })).status).toBe(201);
    expect((await call(registerDevice, 'POST', '/x', { body: { publicKey: newKeyPair().publicKey, platform: 'ANDROID' } })).status).toBe(401);
  });
});

describe('photo evidence', () => {
  it('accepts a signed capture, shrinks it to 1920 px, strips metadata, makes a thumbnail, and keeps the GPS', async () => {
    const withExif = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 10, g: 120, b: 30 } } })
      .withExif({ IFD0: { Copyright: 'secret-owner-name' } })
      .jpeg()
      .toBuffer();
    const r = await uploadMedia(citizen, device, withExif, { lat: 21.2514, lng: 81.6296, accuracyM: 12 });
    expect(r.put!.status).toBe(204);
    expect(r.confirm!.status).toBe(200);
    expect(r.confirm!.body).toEqual(expect.objectContaining({ status: 'READY', kind: 'PHOTO', width: 1920, height: 1280, attached: false, scanStatus: 'SKIPPED' }));

    const stored = (await row(r.mediaId))!;
    expect(stored.object_key).toMatch(/^media\/\d{4}\/\d{2}\/.+\.jpg$/);
    expect(stored.staging_key).toBeNull();
    expect(await Storage.head(`staging/${r.mediaId}`)).toBeNull(); // staging copy is gone
    const out = await sharp(await Storage.get(stored.object_key, 10_000_000)).metadata();
    expect(out).toEqual(expect.objectContaining({ format: 'jpeg', width: 1920, height: 1280 }));
    expect(out.exif).toBeUndefined(); // no EXIF/GPS in the copy we serve
    expect((await sharp(await Storage.get(stored.thumb_key, 1_000_000)).metadata()).width).toBeLessThanOrEqual(320);
    const gps = (await one(db(), `SELECT ST_Latitude(location) AS lat, ST_Longitude(location) AS lng FROM complaint_media WHERE id = ?`, [r.mediaId]))!;
    expect(gps.lat).toBeCloseTo(21.2514, 4);
    expect(gps.lng).toBeCloseTo(81.6296, 4);
    expect(stored.gps_accuracy_m).toBeCloseTo(12, 1);
  });

  it('accepts WebP too and never enlarges a small picture', async () => {
    const r = await uploadMedia(citizen, device, await makeWebp(320, 240), { contentType: 'image/webp' });
    expect(r.confirm!.body).toEqual(expect.objectContaining({ status: 'READY', width: 320, height: 240 }));
  });

  it('the owner can look the upload up; nobody else can', async () => {
    const r = await uploadMedia(citizen, device, await makeJpeg());
    expect((await call(getMedia, 'GET', '/x', { token: citizen, params: { id: r.mediaId } })).body.status).toBe('READY');
    const other = await loginAs(await createUser('CITIZEN', j));
    expect((await call(getMedia, 'GET', '/x', { token: other, params: { id: r.mediaId } })).status).toBe(404);
    expect((await call(getMedia, 'GET', '/x', { token: citizen, params: { id: 'nope' } })).status).toBe(404);
  });
});

describe('what the server refuses', () => {
  async function rejected(data: Buffer, o: Parameters<typeof uploadMedia>[3], why: RegExp) {
    const r = await uploadMedia(citizen, device, data, o);
    expect(r.confirm!.status).toBe(422);
    expect(r.confirm!.body).toEqual(expect.objectContaining({ statusCode: 422, mediaStatus: 'REJECTED' }));
    expect(String(r.confirm!.body.message)).toMatch(why);
    const stored = (await row(r.mediaId))!;
    expect(stored.status).toBe('REJECTED');
    expect(stored.reject_reason).toMatch(why);
    expect(await Storage.head(`staging/${r.mediaId}`)).toBeNull(); // the file is deleted
    // a rejected capture cannot be confirmed again
    expect((await call(confirmRoute, 'POST', '/x', { token: citizen, params: { id: r.mediaId }, body: { manifest: 'AAAA', signature: 'AAAA' } })).status).toBe(409);
    return r;
  }

  it('a manifest signed by a different key', async () => {
    await rejected(await makeJpeg(), { signWith: newKeyPair().privateKey }, /signature is invalid/);
  });
  it('a manifest changed after signing', async () => {
    const data = await makeJpeg();
    const r = await uploadMedia(citizen, device, data, { skipConfirm: true });
    const signed = signManifest(device.privateKey, { v: 1, mediaId: r.mediaId, deviceId: device.id, kind: 'PHOTO', sha256: sha256(data), capturedAt: new Date().toISOString(), lat: 21.2, lng: 81.6, accuracyM: 5, isMockLocation: false });
    const forged = Buffer.from(Buffer.from(signed.manifest, 'base64url').toString().replace('"lat":21.2', '"lat":22.2')).toString('base64url');
    const res = await call(confirmRoute, 'POST', '/x', { token: citizen, params: { id: r.mediaId }, body: { manifest: forged, signature: signed.signature } });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/signature is invalid/);
  });
  it('a manifest made for another upload or device', async () => {
    await rejected(await makeJpeg(), { tweak: (m) => ({ ...m, mediaId: newId() }) }, /different upload/);
    await rejected(await makeJpeg(), { tweak: (m) => ({ ...m, deviceId: newId() }) }, /different upload/);
  });
  it('a manifest that does not describe the declared file', async () => {
    await rejected(await makeJpeg(), { tweak: (m) => ({ ...m, kind: 'VIDEO' }) }, /kind does not match/);
    await rejected(await makeJpeg(), { tweak: (m) => ({ ...m, sha256: 'a'.repeat(64) }) }, /hash does not match/);
  });
  it('a fake GPS location, a poor fix, and capture times that are in the future or too old', async () => {
    await rejected(await makeJpeg(), { mock: true }, /Mock \(fake\) GPS/);
    await rejected(await makeJpeg(), { accuracyM: 101 }, /accuracy worse than 100 m/);
    await rejected(await makeJpeg(), { capturedAt: new Date(Date.now() + 20 * 60_000) }, /in the future/);
    await rejected(await makeJpeg(), { capturedAt: new Date(Date.now() - 25 * 3_600_000) }, /older than 24 hours/);
  });
  it('a file that was never uploaded', async () => {
    await rejected(await makeJpeg(), { skipPut: true }, /was not uploaded/);
  });
  it('bytes that differ from what was signed (same length, different content)', async () => {
    const real = await makeJpeg();
    const swapped = Buffer.from(real);
    swapped[swapped.length - 5] ^= 0xff;
    await rejected(real, { sent: swapped }, /does not match the signed hash/);
  });
  it('content that is not what it claims to be (a PNG labelled as JPEG, with a matching checksum)', async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png({ compressionLevel: 0 }).toBuffer();
    const unique = Buffer.concat([png, Buffer.from(newId())]); // unique checksum
    await rejected(unique, { contentType: 'image/jpeg' }, /does not match its declared type/);
  });
  it('a JPEG that cannot be decoded', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(newId().repeat(20))]);
    await rejected(broken, {}, /Image could not be processed/);
  });
  it('a file carrying the antivirus test signature', async () => {
    const eicar = Buffer.concat([await makeJpeg(), Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
    await rejected(eicar, {}, /malware/);
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE action = 'MALWARE_DETECTED'`)).toBeTruthy();
  });
  it('the same signed capture used twice', async () => {
    const data = await makeJpeg();
    const first = await uploadMedia(citizen, device, data);
    expect(first.confirm!.status).toBe(200);
    await rejected(data, {}, /already been uploaded/);
  });
  it('an upload window that has run out, or a device revoked in the meantime', async () => {
    const a = await uploadMedia(citizen, device, await makeJpeg(), { skipConfirm: true });
    await run(db(), `UPDATE complaint_media SET created_at = DATE_SUB(NOW(3), INTERVAL 31 MINUTE) WHERE id = ?`, [a.mediaId]);
    const res = await call(confirmRoute, 'POST', '/x', { token: citizen, params: { id: a.mediaId }, body: { manifest: 'AAAA', signature: 'AAAA' } });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/window has expired/);

    const b = await uploadMedia(citizen, device, await makeJpeg(), { skipConfirm: true });
    await run(db(), `UPDATE devices SET revoked_at = NOW(3) WHERE id = ?`, [device.id]);
    const res2 = await call(confirmRoute, 'POST', '/x', { token: citizen, params: { id: b.mediaId }, body: { manifest: 'AAAA', signature: 'AAAA' } });
    expect(res2.status).toBe(422);
    expect(res2.body.message).toMatch(/Device has been revoked/);
  });
});

describe('the upload step', () => {
  it('only the owner can send bytes, with exactly the declared type and size, and only once', async () => {
    const data = await makeJpeg();
    const other = await loginAs(await createUser('CITIZEN', j));
    const declared = await uploadMedia(citizen, device, data, { skipPut: true, skipConfirm: true });
    const id = declared.mediaId;
    const put = (token: string, body: Buffer, headers: Record<string, string> = { 'content-type': 'image/jpeg' }) =>
      call(putContent, 'PUT', `/api/v1/media/${id}/content`, { token, params: { id }, rawBytes: body, headers });

    expect((await put(other, data)).status).toBe(404);
    expect((await put(citizen, data, { 'content-type': 'image/webp' })).status).toBe(415);
    expect((await put(citizen, data, {})).status).toBe(415);
    expect((await put(citizen, Buffer.concat([data, Buffer.from('x')]))).status).toBe(413);
    expect((await put(citizen, data.subarray(0, data.length - 1))).status).toBe(400);
    expect((await put(citizen, data, { 'content-type': 'image/jpeg', 'content-length': String(data.length + 5) })).status).toBe(400);
    expect((await call(putContent, 'PUT', `/x`, { params: { id }, rawBytes: data, headers: { 'content-type': 'image/jpeg' } })).status).toBe(401);
    expect(await Storage.head(`staging/${id}`)).toBeNull(); // nothing was kept from the bad attempts
    expect((await put(citizen, data)).status).toBe(204);
    expect((await put(citizen, data)).status).toBe(204); // sending it again before confirming is harmless
    expect((await call(confirmRoute, 'POST', '/x', { token: citizen, params: { id }, body: signManifest(device.privateKey, { v: 1, mediaId: id, deviceId: device.id, kind: 'PHOTO', sha256: sha256(data), capturedAt: new Date().toISOString(), lat: 21, lng: 81, accuracyM: 5, isMockLocation: false }) })).status).toBe(200);
    expect((await put(citizen, data)).status).toBe(409); // already confirmed
  });

  it('refuses to declare an upload that is not allowed', async () => {
    const other = await loginAs(await createUser('CITIZEN', j));
    const base = { deviceId: device.id, kind: 'PHOTO', contentType: 'image/jpeg', bytes: 1000, sha256: 'a'.repeat(64) };
    const post = (token: string, body: unknown) => call(createUpload, 'POST', '/x', { token, body });
    expect((await post(citizen, base)).status).toBe(201);
    expect((await post(other, base)).status).toBe(400); // someone else's device
    expect((await post(citizen, { ...base, deviceId: newId() })).status).toBe(400);
    expect((await post(citizen, { ...base, contentType: 'video/mp4' })).status).toBe(400); // photo cannot be a video
    expect((await post(citizen, { ...base, kind: 'VIDEO', contentType: 'image/jpeg' })).status).toBe(400);
    expect((await post(citizen, { ...base, bytes: 9 * 1024 * 1024 })).status).toBe(400);
    expect((await post(citizen, { ...base, bytes: 0 })).status).toBe(400);
    expect((await post(citizen, { ...base, contentType: 'image/svg+xml' })).status).toBe(400);
    expect((await post(citizen, { ...base, contentType: 'application/pdf' })).status).toBe(400);
    expect((await post(citizen, { ...base, sha256: 'ABC' })).status).toBe(400);
    expect((await post(citizen, { ...base, extra: 1 })).status).toBe(400);
    expect((await post(undefined as unknown as string, base)).status).toBe(401);
  });

  it('limits unfinished uploads and uploads per day', async () => {
    const body = { deviceId: device.id, kind: 'PHOTO', contentType: 'image/jpeg', bytes: 1000 };
    for (let i = 0; i < 20; i++) expect((await call(createUpload, 'POST', '/x', { token: citizen, body: { ...body, sha256: sha256(Buffer.from(`p${i}`)) } })).status).toBe(201);
    expect((await call(createUpload, 'POST', '/x', { token: citizen, body: { ...body, sha256: 'b'.repeat(64) } })).status).toBe(429);

    const t2 = await loginAs(await createUser('CITIZEN', j));
    const d2 = await makeDevice(t2);
    const owner = (await one(db(), `SELECT owner_id FROM complaint_media WHERE device_id = ? LIMIT 1`, [device.id]))!.owner_id;
    void owner;
    for (let i = 0; i < 60; i++) {
      await run(db(), `INSERT INTO complaint_media (owner_id, device_id, kind, status, content_type, declared_bytes, declared_sha256) VALUES ((SELECT user_id FROM devices WHERE id = ?), ?, 'PHOTO', 'REJECTED', 'image/jpeg', 10, ?)`, [d2.id, d2.id, sha256(Buffer.from(`d${i}-${d2.id}`))]);
    }
    expect((await call(createUpload, 'POST', '/x', { token: t2, body: { ...body, deviceId: d2.id, sha256: 'c'.repeat(64) } })).status).toBe(429);
  });
});

describe('signed file links', () => {
  async function uploaded() {
    const r = await uploadMedia(citizen, device, await makeJpeg(800, 600));
    return r.mediaId;
  }

  it('serve the picture and its thumbnail to anyone holding a fresh link, with safe headers', async () => {
    const id = await uploaded();
    const main = await fileCall(signedFileUrl(origin, id, 'main'));
    expect(main.status).toBe(200);
    expect(main.headers.get('content-type')).toBe('image/jpeg');
    expect(main.headers.get('cache-control')).toBe('private, max-age=300');
    expect(main.headers.get('x-content-type-options')).toBe('nosniff');
    expect(main.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(main.headers.get('accept-ranges')).toBe('bytes');
    const thumb = await fileCall(signedFileUrl(origin, id, 'thumb'));
    expect(thumb.status).toBe(200);
  });

  it('refuse a link that was altered, has expired, belongs to another file, or has missing parts', async () => {
    const id = await uploaded();
    const other = await uploaded();
    const good = new URL(signedFileUrl(origin, id, 'main'));
    const withParam = (k: string, v: string | null) => {
      const u = new URL(good);
      if (v === null) u.searchParams.delete(k);
      else u.searchParams.set(k, v);
      return u.toString();
    };
    const exp = Number(good.searchParams.get('exp'));
    for (const [name, url] of [
      ['changed signature', withParam('sig', 'f'.repeat(64))],
      ['short signature', withParam('sig', 'abcd')],
      ['non-hex signature', withParam('sig', 'zz'.repeat(32))],
      ['other variant', withParam('v', 'thumb')],
      ['unknown variant', withParam('v', '../../etc/passwd')],
      ['extended expiry', withParam('exp', String(exp + 3600))],
      ['no signature', withParam('sig', null)],
      ['no expiry', withParam('exp', null)],
      ['someone else\'s file', good.toString().replace(id, other)],
    ] as const) {
      expect((await fileCall(url)).status, name).toBe(403);
    }
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + (FILE_URL_TTL_SECONDS + 5) * 1000);
    expect((await fileCall(good.toString())).status).toBe(403); // expired
    vi.useRealTimers();
    expect((await call(fileRoute, 'GET', '/x', { params: { id: 'nope' } })).status).toBe(404);
  });

  it('support byte ranges, so videos can be played and scrubbed', async () => {
    const id = await uploaded();
    const url = signedFileUrl(origin, id, 'main');
    const full = await fileCall(url);
    const size = Number(full.headers.get('content-length'));
    const part = await fileCall(url, { range: 'bytes=0-9' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-9/${size}`);
    expect(part.headers.get('content-length')).toBe('10');
    const tail = await fileCall(url, { range: 'bytes=-5' });
    expect(tail.headers.get('content-range')).toBe(`bytes ${size - 5}-${size - 1}/${size}`);
    expect((await fileCall(url, { range: `bytes=${size + 10}-` })).status).toBe(416);
    expect((await fileCall(url, { range: 'bytes=5-2' })).status).toBe(416);
    expect((await fileCall(url, { range: 'garbage' })).status).toBe(200);
  });

  it('do not exist for media that was rejected or is unfinished', async () => {
    const r = await uploadMedia(citizen, device, await makeJpeg(), { mock: true });
    expect((await fileCall(signedFileUrl(origin, r.mediaId, 'main'))).status).toBe(404);
  });
});

describe('storage safety', () => {
  it.each(['../secret', 'media/../../etc/passwd', '/etc/passwd', 'media//x', 'media/a b', 'media/x\u0000y', 'other/x', 'staging', 'media/..', 'media/./x', 'C:\\Windows\\win.ini', 'media/%2e%2e/x'])(
    'will not touch %j',
    async (key) => {
      await expect(Storage.put(key, Buffer.from('x'))).rejects.toThrow(/Invalid storage key/);
      await expect(Storage.get(key, 10)).rejects.toThrow();
      expect(await Storage.head(key)).toBeNull();
    },
  );
  it('keeps files only below its own folder', async () => {
    await Storage.put('media/2026/10/abc.thumb.jpg', Buffer.from('hello'));
    expect((await Storage.get('media/2026/10/abc.thumb.jpg', 100)).toString()).toBe('hello');
    await Storage.delete('media/2026/10/abc.thumb.jpg');
    expect(await Storage.head('media/2026/10/abc.thumb.jpg')).toBeNull();
    await expect(Storage.get('media/2026/10/abc.thumb.jpg', 100)).rejects.toThrow();
  });
});

describe('video evidence', () => {
  it.skipIf(!FFMPEG)('is accepted at once, compressed in the background, and gets a thumbnail', async () => {
    const mp4 = makeMp4(2);
    const r = await uploadMedia(citizen, device, mp4, { kind: 'VIDEO' });
    expect(r.confirm!.status).toBe(200);
    expect(r.confirm!.body.status).toBe('PROCESSING');
    expect(await runVideoJobs()).toBe(1);
    const done = await call(getMedia, 'GET', '/x', { token: citizen, params: { id: r.mediaId } });
    expect(done.body).toEqual(expect.objectContaining({ status: 'READY', width: 160, height: 120 }));
    expect(done.body.durationS).toBeGreaterThan(1.5);
    const stored = (await row(r.mediaId))!;
    expect(stored.thumb_key).toBeTruthy();
    expect((await fileCall(signedFileUrl(origin, r.mediaId, 'main'))).headers.get('content-type')).toBe('video/mp4');
    expect((await fileCall(signedFileUrl(origin, r.mediaId, 'thumb'))).status).toBe(200);
  });

  it.skipIf(!FFMPEG)('a video longer than the limit is rejected, and the owner is told', async () => {
    const r = await uploadMedia(citizen, device, makeMp4(40), { kind: 'VIDEO' });
    expect(r.confirm!.status).toBe(200);
    await runVideoJobs();
    const stored = (await row(r.mediaId))!;
    expect(stored.status).toBe('REJECTED');
    expect(stored.reject_reason).toMatch(/longer than 30 seconds/);
    expect(await Storage.head(`staging/${r.mediaId}`)).toBeNull();
    const notice = await one(db(), `SELECT type FROM notifications WHERE user_id = (SELECT owner_id FROM complaint_media WHERE id = ?) AND type = 'MEDIA_REJECTED'`, [r.mediaId]);
    expect(notice).toBeTruthy();
  });

  it.skipIf(!FFMPEG)('something that only looks like a video is rejected by the background check', async () => {
    const fake = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from(newId().repeat(10))]);
    const r = await uploadMedia(citizen, device, fake, { kind: 'VIDEO' });
    expect(r.confirm!.status).toBe(200);
    await runVideoJobs();
    expect((await row(r.mediaId))!.status).toBe('REJECTED');
  });

  it('without FFmpeg a valid video is kept exactly as uploaded, with no thumbnail', async () => {
    process.env.FFMPEG_PATH = '/definitely/not/installed/ffmpeg';
    process.env.FFPROBE_PATH = '/definitely/not/installed/ffprobe';
    resetConfigForTests();
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from(newId().repeat(5))]); // content is not decoded
    const r = await uploadMedia(citizen, device, mp4, { kind: 'VIDEO' });
    expect(r.confirm!.body.status).toBe('PROCESSING');
    await runVideoJobs();
    const stored = (await row(r.mediaId))!;
    expect(stored).toEqual(expect.objectContaining({ status: 'READY', thumb_key: null, width: null }));
    const bytes = await fileCall(signedFileUrl(origin, r.mediaId, 'main'));
    expect(bytes.status).toBe(200);
    expect((await fileCall(signedFileUrl(origin, r.mediaId, 'thumb'))).status).toBe(404);
  });

  it('a temporary problem is retried; only the last failed attempt rejects the video', async () => {
    process.env.FFMPEG_PATH = '/definitely/not/installed/ffmpeg';
    resetConfigForTests();
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from(newId().repeat(5))]);
    const r = await uploadMedia(citizen, device, mp4, { kind: 'VIDEO' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(Storage, 'get').mockRejectedValue(new Error('disk hiccup'));
    await expect(MediaService.processVideoJob(r.mediaId, { attempts: 1, max_attempts: 3 })).rejects.toThrow('disk hiccup');
    expect((await row(r.mediaId))!.status).toBe('PROCESSING'); // still waiting for a retry
    await MediaService.processVideoJob(r.mediaId, { attempts: 3, max_attempts: 3 }); // last attempt
    expect((await row(r.mediaId))!.status).toBe('REJECTED');
    spy.mockRestore();
  });

  it('re-queues videos whose job was lost, once each', async () => {
    process.env.FFMPEG_PATH = '/definitely/not/installed/ffmpeg';
    resetConfigForTests();
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from(newId().repeat(5))]);
    const r = await uploadMedia(citizen, device, mp4, { kind: 'VIDEO' });
    await run(db(), 'DELETE FROM jobs');
    expect(await MediaService.requeueStalledVideos()).toBe(0); // only just confirmed
    await run(db(), `UPDATE complaint_media SET confirmed_at = DATE_SUB(NOW(3), INTERVAL 11 MINUTE) WHERE id = ?`, [r.mediaId]);
    expect(await MediaService.requeueStalledVideos()).toBe(1);
    await MediaService.requeueStalledVideos();
    expect(await query(db(), `SELECT id FROM jobs WHERE queue = 'video' AND status = 'PENDING'`)).toHaveLength(1);
  });
});

describe('housekeeping', () => {
  it('removes media nobody attached within a day, with its files, and leaves recent media alone', async () => {
    const old = await uploadMedia(citizen, device, await makeJpeg());
    const recent = await uploadMedia(citizen, device, await makeJpeg());
    const oldRow = (await row(old.mediaId))!;
    await run(db(), `UPDATE complaint_media SET created_at = DATE_SUB(NOW(3), INTERVAL 25 HOUR) WHERE id = ?`, [old.mediaId]);
    expect(await Storage.head(oldRow.object_key)).not.toBeNull();
    expect(await MediaService.purgeOrphans()).toBeGreaterThanOrEqual(1);
    expect(await row(old.mediaId)).toBeUndefined();
    expect(await Storage.head(oldRow.object_key)).toBeNull();
    expect(await Storage.head(oldRow.thumb_key)).toBeNull();
    expect(await row(recent.mediaId)).toBeTruthy();
  });
});
