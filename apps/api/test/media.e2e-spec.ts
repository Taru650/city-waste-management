import sharp from 'sharp';
import { Role } from '../src/common/enums';
import { MediaService } from '../src/modules/media/media.service';
import { StorageService } from '../src/modules/storage/storage.service';
import {
  api, bearer, capture, createJurisdiction, createTestApp, createUser, Jurisdiction, quickMedia, TestCtx, TestDevice, TestUser, tokenFor,
} from './helpers';
import { makePhoto, makeVideo, ssim, variant } from './media-fixtures';

describe('Media pipeline: camera-only capture, compression, evidence (M3)', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let typeId: string;
  let photo: Buffer;
  let citizen: TestUser;
  let citizenToken: string;
  let device: TestDevice;
  let supervisor: TestUser;
  let worker: TestUser;
  let workerToken: string;
  let media: MediaService;
  let storage: StorageService;

  beforeAll(async () => {
    ctx = await createTestApp();
    media = ctx.app.get(MediaService);
    storage = ctx.app.get(StorageService);
    j = await createJurisdiction(ctx.ds);
    typeId = (await ctx.http().get(api('/masters/complaint-types'))).body[0].id;
    photo = await makePhoto(4000, 3000, 95);
    supervisor = await createUser(ctx, Role.SUPERVISOR, j);
    await ctx.ds.query(`UPDATE areas SET supervisor_id = $1 WHERE id = $2`, [supervisor.id, j.areaId]);
    worker = await createUser(ctx, Role.WORKER, j);
    workerToken = await tokenFor(ctx, worker);
  });
  afterAll(async () => {
    await media.idle();
    await ctx.app.close();
  });
  beforeEach(async () => {
    citizen = await createUser(ctx, Role.CITIZEN, j);
    citizenToken = await tokenFor(ctx, citizen);
    device = await TestDevice.register(ctx, citizenToken);
  });

  const at = () => j.wards[0].center;
  const fileComplaint = (mediaIds: string[]) =>
    ctx.http().post(api('/complaints')).set(bearer(citizenToken)).send({ typeId, ...at(), description: 'Kachra pada hai', mediaIds });

  describe('devices', () => {
    it('registration is idempotent per key and a key cannot be shared between accounts', async () => {
      const again = await ctx.http().post(api('/devices')).set(bearer(citizenToken)).send({ publicKey: device.publicKeyB64, platform: 'ANDROID' }).expect(201);
      expect(again.body.id).toBe(device.id);
      const other = await tokenFor(ctx, await createUser(ctx, Role.CITIZEN, j));
      await ctx.http().post(api('/devices')).set(bearer(other)).send({ publicKey: device.publicKeyB64, platform: 'ANDROID' }).expect(409);
    });

    it('keeps at most 5 active devices per user', async () => {
      for (let i = 0; i < 5; i++) await TestDevice.register(ctx, citizenToken);
      const list = await ctx.http().get(api('/devices')).set(bearer(citizenToken)).expect(200);
      expect(list.body).toHaveLength(5);
      expect(list.body.map((d: { id: string }) => d.id)).not.toContain(device.id);
    });

    it('a revoked device cannot request uploads', async () => {
      await ctx.http().delete(api(`/devices/${device.id}`)).set(bearer(citizenToken)).expect(204);
      const { upload } = await capture(ctx, citizenToken, device, variant(photo));
      expect(upload.status).toBe(400);
    });

    it('web-only roles cannot register devices or upload', async () => {
      const da = await tokenFor(ctx, await createUser(ctx, Role.DISTRICT_ADMIN, j));
      await ctx.http().post(api('/devices')).set(bearer(da)).send({ publicKey: device.publicKeyB64, platform: 'ANDROID' }).expect(403);
    });
  });

  describe('photos', () => {
    it('verifies, compresses and stores a 12 MP capture; served copy is small, sharp and metadata-free', async () => {
      const { confirm, mediaId } = await capture(ctx, citizenToken, device, variant(photo), { location: at() });
      expect(confirm!.status).toBe(200);
      expect(confirm!.body).toEqual(expect.objectContaining({ status: 'READY', kind: 'PHOTO', width: 1920, height: 1440, scanStatus: 'SKIPPED' }));
      expect(confirm!.body.storedBytes).toBeLessThan(photo.length / 4);

      // staging copy is removed once processed
      const [row] = await ctx.ds.query(`SELECT staging_key, object_key FROM complaint_media WHERE id = $1`, [mediaId]);
      expect(row.staging_key).toBeNull();

      const complaint = await fileComplaint([mediaId]).expect(201);
      const list = await ctx.http().get(api(`/complaints/${complaint.body.id}/media`)).set(bearer(citizenToken)).expect(200);
      expect(list.body).toEqual([expect.objectContaining({ id: mediaId, stage: 'COMPLAINT', kind: 'PHOTO', uploaderRole: 'CITIZEN', outsideGeofence: false })]);
      expect(list.body[0].url).toMatch(/X-Amz-Expires=300/);

      const served = Buffer.from(await (await fetch(list.body[0].url)).arrayBuffer());
      expect((await sharp(served).metadata()).exif).toBeUndefined();
      expect(await ssim(photo, served)).toBeGreaterThanOrEqual(0.95);
      const thumb = Buffer.from(await (await fetch(list.body[0].thumbnailUrl)).arrayBuffer());
      expect(Math.max((await sharp(thumb).metadata()).width!, (await sharp(thumb).metadata()).height!)).toBe(320);
    });

    it('a complaint needs at least one capture, and a capture can be used only once', async () => {
      await fileComplaint([]).expect(400);
      const { mediaId } = await capture(ctx, citizenToken, device, variant(photo));
      await fileComplaint([mediaId]).expect(201);
      await fileComplaint([mediaId]).expect(400);
    });

    it('limits each stage to 5 photos and 1 video', async () => {
      const ids = await Promise.all(Array.from({ length: 6 }, () => quickMedia(ctx, citizen.id, at())));
      await fileComplaint(ids).expect(400);
      await fileComplaint(ids.slice(0, 5)).expect(201);
    });

    it('flags evidence captured far from the complaint location', async () => {
      const far = { lat: at().lat + 0.01, lng: at().lng }; // ~1.1 km away
      const { mediaId } = await capture(ctx, citizenToken, device, variant(photo), { location: far });
      const complaint = await fileComplaint([mediaId]).expect(201);
      const list = await ctx.http().get(api(`/complaints/${complaint.body.id}/media`)).set(bearer(citizenToken)).expect(200);
      expect(list.body[0]).toEqual(expect.objectContaining({ outsideGeofence: true }));
      expect(list.body[0].distanceM).toBeGreaterThan(1000);
    });
  });

  describe('field worker proof', () => {
    it('worker proof photos are required, must be taken after the complaint, and appear as before/after for the citizen', async () => {
      const complaint = (await fileComplaint([await quickMedia(ctx, citizen.id, at())]).expect(201)).body;
      await ctx.http().post(api(`/complaints/${complaint.id}/assign`)).set(bearer(await tokenFor(ctx, supervisor))).send({ workerId: worker.id }).expect(201);

      const workerDevice = await TestDevice.register(ctx, workerToken);
      const old = await quickMedia(ctx, worker.id, at());
      await ctx.ds.query(`UPDATE complaint_media SET captured_at = now() - interval '2 hours' WHERE id = $1`, [old]);
      await ctx.http().post(api(`/complaints/${complaint.id}/start`)).set(bearer(workerToken)).send({ mediaIds: [old] }).expect(400);

      const before = await capture(ctx, workerToken, workerDevice, await makePhoto(1600, 1200, 85), { location: at() });
      await ctx.http().post(api(`/complaints/${complaint.id}/start`)).set(bearer(workerToken)).send({ mediaIds: [before.mediaId] }).expect(201);
      const after = await capture(ctx, workerToken, workerDevice, await makePhoto(1600, 1200, 80), { location: at() });
      await ctx.http().post(api(`/complaints/${complaint.id}/resolve`)).set(bearer(workerToken))
        .send({ remark: 'Kachra uthaya, safai ki', mediaIds: [after.mediaId] }).expect(201);

      const list = await ctx.http().get(api(`/complaints/${complaint.id}/media`)).set(bearer(citizenToken)).expect(200);
      expect(list.body.map((m: { stage: string; uploaderRole: string }) => [m.stage, m.uploaderRole])).toEqual([
        ['COMPLAINT', 'CITIZEN'], ['WORK_START', 'WORKER'], ['RESOLUTION', 'WORKER'],
      ]);
    });

    it('a worker cannot attach a citizen\'s media as their own proof', async () => {
      const complaint = (await fileComplaint([await quickMedia(ctx, citizen.id, at())]).expect(201)).body;
      await ctx.http().post(api(`/complaints/${complaint.id}/assign`)).set(bearer(await tokenFor(ctx, supervisor))).send({ workerId: worker.id }).expect(201);
      const citizensPhoto = await quickMedia(ctx, citizen.id, at());
      await ctx.http().post(api(`/complaints/${complaint.id}/start`)).set(bearer(workerToken)).send({ mediaIds: [citizensPhoto] }).expect(400);
    });
  });

  describe('video', () => {
    it('accepts a short clip, transcodes it to 720p in the background, and serves it', async () => {
      const clip = makeVideo(4);
      const { confirm, mediaId } = await capture(ctx, citizenToken, device, clip, { kind: 'VIDEO', location: at() });
      expect(confirm!.status).toBe(200);
      expect(confirm!.body.status).toBe('PROCESSING');
      // a processing video can already be attached to the complaint
      const complaint = await fileComplaint([mediaId]).expect(201);
      await media.idle();
      const done = await ctx.http().get(api(`/media/${mediaId}`)).set(bearer(citizenToken)).expect(200);
      expect(done.body).toEqual(expect.objectContaining({ status: 'READY', height: 720 }));
      expect(done.body.storedBytes).toBeLessThan(clip.length / 2);
      const list = await ctx.http().get(api(`/complaints/${complaint.body.id}/media`)).set(bearer(citizenToken)).expect(200);
      const served = await fetch(list.body[0].url);
      expect(served.ok).toBe(true);
      expect(Buffer.from(await served.arrayBuffer()).toString('ascii', 4, 8)).toBe('ftyp');
    }, 120_000);

    it('rejects clips longer than 30 seconds', async () => {
      const { mediaId } = await capture(ctx, citizenToken, device, makeVideo(32, '320x240', 35), { kind: 'VIDEO' });
      await media.idle();
      const res = await ctx.http().get(api(`/media/${mediaId}`)).set(bearer(citizenToken)).expect(200);
      expect(res.body).toEqual(expect.objectContaining({ status: 'REJECTED', rejectReason: expect.stringMatching(/longer than 30 seconds/) }));
    }, 120_000);
  });

  describe('housekeeping', () => {
    it('a storage outage during confirm returns 500 without leaking details and leaves the upload retryable', async () => {
      const file = variant(photo);
      const spy = jest.spyOn(storage, 'head').mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:9000'));
      const first = await capture(ctx, citizenToken, device, file);
      spy.mockRestore();
      expect(first.confirm!.status).toBe(500);
      expect(JSON.stringify(first.confirm!.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
      const [row] = await ctx.ds.query(`SELECT status FROM complaint_media WHERE id = $1`, [first.mediaId]);
      expect(row.status).toBe('PENDING_UPLOAD');
    });

    it('purges unattached uploads after 24 hours, including stored objects', async () => {
      const { mediaId } = await capture(ctx, citizenToken, device, variant(photo));
      const [row] = await ctx.ds.query(`SELECT object_key FROM complaint_media WHERE id = $1`, [mediaId]);
      expect(await storage.head(row.object_key)).not.toBeNull();
      await ctx.ds.query(`UPDATE complaint_media SET created_at = now() - interval '25 hours' WHERE id = $1`, [mediaId]);
      expect(await media.purgeOrphans()).toBeGreaterThanOrEqual(1);
      expect(await ctx.ds.query(`SELECT 1 FROM complaint_media WHERE id = $1`, [mediaId])).toHaveLength(0);
      expect(await storage.head(row.object_key)).toBeNull();
    });
  });
});
