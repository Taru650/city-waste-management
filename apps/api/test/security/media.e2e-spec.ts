import { generateKeyPairSync } from 'crypto';
import sharp from 'sharp';
import { Role } from '../../src/common/enums';
import {
  api, bearer, capture, createJurisdiction, createTestApp, createUser, Jurisdiction, quickMedia, TestCtx, TestDevice, TestUser, tokenFor,
} from '../helpers';
import { EICAR, fakeClamd } from '../fake-clamd';
import { makePhoto, variant } from '../media-fixtures';

/**
 * Camera-only evidence: an attacker with a valid account must not be able to upload gallery
 * images, edited files, someone else's capture, non-image content or malware.
 */
describe('Security: media uploads', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let photo: Buffer;
  let user: TestUser;
  let token: string;
  let device: TestDevice;

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
    photo = await makePhoto(1200, 900, 85);
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    user = await createUser(ctx, Role.CITIZEN, j);
    token = await tokenFor(ctx, user);
    device = await TestDevice.register(ctx, token);
  });

  const expectRejected = async (res: { status: number; body: { mediaStatus?: string; message?: string } } | undefined, reason: RegExp) => {
    expect(res?.status).toBe(422);
    expect(res?.body.mediaStatus).toBe('REJECTED');
    expect(res?.body.message).toMatch(reason);
  };

  describe('capture signature (proves the file came from the registered app install)', () => {
    it('rejects a missing/invalid signature and deletes the uploaded object', async () => {
      const { confirm, mediaId } = await capture(ctx, token, device, variant(photo), { signature: Buffer.alloc(70, 1).toString('base64') });
      await expectRejected(confirm, /signature is invalid/);
      const [row] = await ctx.ds.query(`SELECT status, staging_key FROM complaint_media WHERE id = $1`, [mediaId]);
      expect(row.status).toBe('REJECTED');
      const head = await fetch(`${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${row.staging_key}`, { method: 'HEAD' });
      expect(head.status).toBe(404);
    });

    it('rejects a manifest signed by a key that is not the registered device key', async () => {
      const rogue = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
      const up = await ctx.http().post(api('/media/upload-url')).set(bearer(token))
        .send({ deviceId: device.id, kind: 'PHOTO', contentType: 'image/jpeg', bytes: 10, sha256: 'a'.repeat(64) }).expect(201);
      const signed = device.sign({ v: 1, mediaId: up.body.mediaId, deviceId: device.id, kind: 'PHOTO', sha256: 'a'.repeat(64),
        capturedAt: new Date().toISOString(), lat: 21, lng: 81, accuracyM: 5, isMockLocation: false }, rogue);
      const res = await ctx.http().post(api(`/media/${up.body.mediaId}/confirm`)).set(bearer(token)).send(signed);
      await expectRejected(res, /signature is invalid/);
    });

    it('a valid manifest cannot be replayed for another upload', async () => {
      const first = await capture(ctx, token, device, variant(photo));
      expect(first.confirm!.status).toBe(200);
      const { confirm } = await capture(ctx, token, device, variant(photo), { manifest: (m) => ({ ...m, mediaId: first.mediaId }) });
      await expectRejected(confirm, /different upload/);
    });

    it('the same captured file cannot be uploaded twice', async () => {
      const file = variant(photo);
      expect((await capture(ctx, token, device, file)).confirm!.status).toBe(200);
      await expectRejected((await capture(ctx, token, device, file)).confirm, /already been uploaded/);
    });

    it.each([
      ['older than 24 hours (gallery photo)', { capturedAt: new Date(Date.now() - 25 * 3600_000) }, /older than 24 hours/],
      ['in the future', { capturedAt: new Date(Date.now() + 3600_000) }, /in the future/],
      ['with a mock GPS location', { isMockLocation: true }, /Mock/],
      ['with poor GPS accuracy', { accuracyM: 500 }, /accuracy/],
    ])('rejects a capture %s', async (_name, opts, reason) => {
      await expectRejected((await capture(ctx, token, device, variant(photo), opts)).confirm, reason);
    });

    it('a revoked device can no longer confirm, and password reset revokes all devices', async () => {
      const up = await ctx.http().post(api('/media/upload-url')).set(bearer(token))
        .send({ deviceId: device.id, kind: 'PHOTO', contentType: 'image/jpeg', bytes: 10, sha256: 'b'.repeat(64) }).expect(201);
      await ctx.http().delete(api(`/devices/${device.id}`)).set(bearer(token)).expect(204);
      const signed = device.sign({ v: 1, mediaId: up.body.mediaId, deviceId: device.id, kind: 'PHOTO', sha256: 'b'.repeat(64),
        capturedAt: new Date().toISOString(), lat: 21, lng: 81, accuracyM: 5, isMockLocation: false });
      await expectRejected(await ctx.http().post(api(`/media/${up.body.mediaId}/confirm`)).set(bearer(token)).send(signed), /revoked/);

      const d2 = await TestDevice.register(ctx, token);
      await ctx.http().post(api('/auth/forgot-password')).send({ identifier: user.email }).expect(202);
      await ctx.http().post(api('/auth/reset-password')).send({ token: ctx.mail.lastTokenFor(user.email), newPassword: 'Reset#Swachh2026' }).expect(204);
      const [row] = await ctx.ds.query(`SELECT revoked_at FROM devices WHERE id = $1`, [d2.id]);
      expect(row.revoked_at).not.toBeNull();
    });
  });

  describe('file integrity and type', () => {
    it('rejects a file changed after signing (hash mismatch)', async () => {
      const file = variant(photo);
      const edited = Buffer.from(file);
      edited[edited.length - 40] ^= 0xff; // same size, different content
      await expectRejected((await capture(ctx, token, device, file, { uploadBody: edited })).confirm, /does not match the signed hash/);
    });

    it('rejects an upload whose size differs from the declared size', async () => {
      const file = variant(photo);
      await expectRejected((await capture(ctx, token, device, file, { uploadBody: Buffer.concat([file, Buffer.alloc(100)]) })).confirm, /size/);
    });

    it.each([
      ['PNG declared as JPEG', async () => sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).png().toBuffer()],
      ['HTML declared as JPEG', async () => Buffer.from('<html><script>alert(document.cookie)</script></html>')],
      ['SVG declared as JPEG', async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
      ['ELF binary declared as JPEG', async () => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)])],
    ])('rejects %s (content sniffed by magic bytes)', async (_name, make) => {
      await expectRejected((await capture(ctx, token, device, await make())).confirm, /does not match its declared type/);
    });

    it('rejects a JPEG uploaded as a VIDEO', async () => {
      await expectRejected((await capture(ctx, token, device, variant(photo), { kind: 'VIDEO' })).confirm, /does not match its declared type/);
    });

    it('rejects a JPEG header followed by garbage (undecodable image)', async () => {
      const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not really an image'.repeat(20))]);
      await expectRejected((await capture(ctx, token, device, fake)).confirm, /could not be processed/);
    });

    it.each([['image/png'], ['image/svg+xml'], ['text/html'], ['application/octet-stream'], ['image/gif']])(
      'refuses to issue an upload URL for %s',
      async (contentType) => {
        await ctx.http().post(api('/media/upload-url')).set(bearer(token))
          .send({ deviceId: device.id, kind: 'PHOTO', contentType, bytes: 1000, sha256: 'c'.repeat(64) }).expect(400);
      },
    );

    it('refuses oversize declarations (photo > 8 MB, video > 60 MB)', async () => {
      const req = (kind: string, contentType: string, bytes: number) => ctx.http().post(api('/media/upload-url')).set(bearer(token))
        .send({ deviceId: device.id, kind, contentType, bytes, sha256: 'd'.repeat(64) });
      await req('PHOTO', 'image/jpeg', 8 * 1024 * 1024 + 1).expect(400);
      await req('VIDEO', 'video/mp4', 60 * 1024 * 1024 + 1).expect(400);
      await req('PHOTO', 'video/mp4', 1000).expect(400);
    });
  });

  describe('ownership and access', () => {
    it('cannot confirm, read or attach another user\'s media', async () => {
      const victimMedia = (await capture(ctx, token, device, variant(photo))).mediaId;
      const attacker = await tokenFor(ctx, await createUser(ctx, Role.CITIZEN, j));
      await ctx.http().get(api(`/media/${victimMedia}`)).set(bearer(attacker)).expect(404);
      await ctx.http().post(api(`/media/${victimMedia}/confirm`)).set(bearer(attacker)).send({ manifest: 'abc', signature: 'YWJj' }).expect(404);
      const typeId = (await ctx.http().get(api('/masters/complaint-types'))).body[0].id;
      await ctx.http().post(api('/complaints')).set(bearer(attacker))
        .send({ typeId, ...j.wards[0].center, description: 'Using stolen photo', mediaIds: [victimMedia] }).expect(400);
    });

    it('cannot upload with someone else\'s device', async () => {
      const attacker = await tokenFor(ctx, await createUser(ctx, Role.CITIZEN, j));
      await ctx.http().post(api('/media/upload-url')).set(bearer(attacker))
        .send({ deviceId: device.id, kind: 'PHOTO', contentType: 'image/jpeg', bytes: 1000, sha256: 'e'.repeat(64) }).expect(400);
    });

    it('evidence of a complaint is visible only within its scope, via 5-minute signed URLs', async () => {
      const typeId = (await ctx.http().get(api('/masters/complaint-types'))).body[0].id;
      const c = await ctx.http().post(api('/complaints')).set(bearer(token))
        .send({ typeId, ...j.wards[0].center, description: 'Garbage near the temple', mediaIds: [await quickMedia(ctx, user.id, j.wards[0].center)] })
        .expect(201);
      const stranger = await tokenFor(ctx, await createUser(ctx, Role.CITIZEN, j));
      const otherUlbSupervisor = await tokenFor(ctx, await createUser(ctx, Role.SUPERVISOR, await createJurisdiction(ctx.ds)));
      await ctx.http().get(api(`/complaints/${c.body.id}/media`)).set(bearer(stranger)).expect(404);
      await ctx.http().get(api(`/complaints/${c.body.id}/media`)).set(bearer(otherUlbSupervisor)).expect(404);
      const own = await ctx.http().get(api(`/complaints/${c.body.id}/media`)).set(bearer(token)).expect(200);
      expect(own.body[0].url).toMatch(/X-Amz-Expires=300/);
    });

    it('a confirm can only run once', async () => {
      const r = await capture(ctx, token, device, variant(photo));
      expect(r.confirm!.status).toBe(200);
      await ctx.http().post(api(`/media/${r.mediaId}/confirm`)).set(bearer(token)).send({ manifest: 'abc', signature: 'YWJj' }).expect(409);
    });

    it('caps unfinished uploads per user', async () => {
      const req = () => ctx.http().post(api('/media/upload-url')).set(bearer(token))
        .send({ deviceId: device.id, kind: 'PHOTO', contentType: 'image/jpeg', bytes: 1000, sha256: 'f'.repeat(64) });
      for (let i = 0; i < 20; i++) await req().expect(201);
      const res = await req().expect(429);
      // The apps show `message` to the user.
      expect(res.body).toEqual({ statusCode: 429, message: 'Too many unfinished uploads' });
    });
  });
});

describe('Security: malware scanning of uploads', () => {
  const saved = process.env.CLAMAV_HOST;
  const savedPort = process.env.CLAMAV_PORT;
  let ctx: TestCtx;
  let clamd: Awaited<ReturnType<typeof fakeClamd>>;
  let token: string;
  let device: TestDevice;
  let photo: Buffer;

  beforeAll(async () => {
    clamd = await fakeClamd();
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(clamd.port);
    ctx = await createTestApp();
    const j = await createJurisdiction(ctx.ds);
    const u = await createUser(ctx, Role.CITIZEN, j);
    token = await tokenFor(ctx, u);
    device = await TestDevice.register(ctx, token);
    photo = await makePhoto(800, 600, 85);
  });
  afterAll(async () => {
    await ctx.app.close();
    clamd.server.close();
    if (saved === undefined) delete process.env.CLAMAV_HOST; else process.env.CLAMAV_HOST = saved;
    if (savedPort === undefined) delete process.env.CLAMAV_PORT; else process.env.CLAMAV_PORT = savedPort;
  });

  it('scans clean files and records the result', async () => {
    const { confirm } = await capture(ctx, token, device, variant(photo));
    expect(confirm!.status).toBe(200);
    expect(confirm!.body.scanStatus).toBe('CLEAN');
  });

  it('rejects an infected file and writes a MALWARE_DETECTED audit entry', async () => {
    const infected = Buffer.concat([variant(photo), Buffer.from(EICAR)]);
    const { confirm, mediaId } = await capture(ctx, token, device, infected);
    expect(confirm!.status).toBe(422);
    expect(confirm!.body.message).toMatch(/malware/);
    const [audit] = await ctx.ds.query(`SELECT meta FROM audit_logs WHERE action = 'MALWARE_DETECTED' AND entity_id = $1`, [mediaId]);
    expect(audit.meta).toEqual({ signature: 'Eicar-Test-Signature' });
  });

  it('fails closed (503, retryable) when the scanner is down', async () => {
    clamd.server.close();
    await new Promise((r) => setTimeout(r, 50));
    process.env.CLAMAV_PORT = '1';
    const down = await createTestApp();
    try {
      const j = await createJurisdiction(down.ds);
      const t = await tokenFor(down, await createUser(down, Role.CITIZEN, j));
      const d = await TestDevice.register(down, t);
      const { confirm, mediaId } = await capture(down, t, d, variant(photo));
      expect(confirm!.status).toBe(503);
      const [row] = await down.ds.query(`SELECT status FROM complaint_media WHERE id = $1`, [mediaId]);
      expect(row.status).toBe('PENDING_UPLOAD');
    } finally {
      await down.app.close();
    }
  });
});
