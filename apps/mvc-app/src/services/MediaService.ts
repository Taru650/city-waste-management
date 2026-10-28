import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { db } from '@/db/connection';
import type { Db } from '@/db/sql';
import { getConfig } from '@/config/env';
import { JobQueue, QUEUES } from '@/jobs/queue';
import { CaptureManifest, ManifestError, parseDevicePublicKey, verifyManifest } from '@/lib/captureManifest';
import { HttpError, badRequest, conflict, isDuplicateKey, notFound, tooMany, unavailable } from '@/lib/errors';
import { detectType } from '@/lib/fileSignature';
import { newId } from '@/lib/ids';
import { scan } from '@/lib/malware';
import { MediaProcessingError, processPhoto, processVideo } from '@/lib/mediaProcessor';
import { templates } from '@/lib/notificationTemplates';
import { signedFileUrl, verifyFileUrl } from '@/lib/signedUrl';
import { Storage } from '@/lib/storage';
import { AuditModel } from '@/models/AuditModel';
import { DeviceModel } from '@/models/DeviceModel';
import { MediaModel, type MediaKind, type MediaStage, type PendingMedia } from '@/models/MediaModel';
import type { JobRow } from '@/models/JobModel';
import type { AuthUser } from '@/middleware/auth';
import { ALLOWED_TYPES, MAX_BYTES } from '@/validation/media';
import { NotificationService } from './NotificationService';

export const MAX_PER_STAGE = { PHOTO: 5, VIDEO: 1 };
export const MAX_PENDING_UPLOADS = 20;
export const MAX_UPLOADS_PER_DAY = { citizen: 60, staff: 300 };
export const CONFIRM_WINDOW_MINUTES = 30;
export const FUTURE_SKEW_MINUTES = 5;
export const ORPHAN_HOURS = 24;
export const MEDIA_GEOFENCE_METERS = 100;
export const VIDEO_JOB_ATTEMPTS = 3;

class Rejection extends Error {}

interface AttachRules {
  requireAny?: boolean;
  requirePhoto?: boolean;
  capturedAfter?: Date;
}

/**
 * Camera-only evidence pipeline:
 *   1. POST /media/upload-url     declares one file (type, size, sha256) and returns where to PUT it
 *   2. PUT  /media/{id}/content   the app sends the compressed file
 *   3. POST /media/{id}/confirm   signed capture manifest; the server verifies signature, freshness, GPS, hash, real
 *                                 file type and malware, then re-encodes (photo now, video in the background)
 *   4. the media id is attached when filing a complaint, starting or resolving work
 */
export const MediaService = {
  async createUpload(user: AuthUser, v: { deviceId: string; kind: MediaKind; contentType: string; bytes: number; sha256: string }, origin: string) {
    if (!ALLOWED_TYPES[v.kind].includes(v.contentType)) throw badRequest(`${v.contentType} is not allowed for ${v.kind}`);
    if (v.bytes > MAX_BYTES[v.kind]) throw badRequest(`${v.kind} must be at most ${MAX_BYTES[v.kind]} bytes`);
    const device = await DeviceModel.findActive(db(), user.id, v.deviceId);
    if (!device) throw badRequest('Unknown or revoked device; register the device again');

    const counts = await MediaModel.uploadCounts(db(), user.id, CONFIRM_WINDOW_MINUTES);
    if (counts.pending >= MAX_PENDING_UPLOADS) throw tooMany('Too many unfinished uploads');
    if (counts.today >= (user.role === 'CITIZEN' ? MAX_UPLOADS_PER_DAY.citizen : MAX_UPLOADS_PER_DAY.staff)) throw tooMany('Daily upload limit reached');

    const id = newId();
    await MediaModel.insertPending(db(), { id, ownerId: user.id, deviceId: device.id, kind: v.kind, contentType: v.contentType, bytes: v.bytes, sha256: v.sha256 });
    return {
      mediaId: id,
      uploadUrl: `${origin}/api/v1/media/${id}/content`,
      method: 'PUT',
      headers: { 'Content-Type': v.contentType, 'Content-Length': String(v.bytes) },
      expiresInSeconds: CONFIRM_WINDOW_MINUTES * 60,
    };
  },

  /** Receives the file bytes for a declared upload. The declared type and size are enforced exactly. */
  async receiveUpload(user: AuthUser, id: string, req: Request): Promise<void> {
    const media = await MediaModel.findAwaitingUpload(db(), id, user.id, CONFIRM_WINDOW_MINUTES);
    if (!media) throw notFound('Media not found');
    if (media.status !== 'PENDING_UPLOAD') throw conflict(`Media is already ${media.status}`);
    if (media.expired) throw new HttpError(410, 'Upload window has expired; start again');

    const declaredType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (declaredType !== media.content_type) throw new HttpError(415, `Content-Type must be ${media.content_type}`);
    const length = req.headers.get('content-length');
    if (length !== null && Number(length) !== media.declared_bytes) throw badRequest('Size does not match the declared size');
    if (!req.body) throw badRequest('The request has no body');

    const chunks: Buffer[] = [];
    let total = 0;
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > media.declared_bytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, 'File is larger than the declared size');
      }
      chunks.push(Buffer.from(value));
    }
    if (total !== media.declared_bytes) throw badRequest('Size does not match the declared size');
    await Storage.put(media.staging_key, Buffer.concat(chunks));
  },

  async confirm(user: AuthUser, id: string, v: { manifest: string; signature: string }, ip: string | null) {
    const media = await MediaModel.findForConfirm(db(), id, user.id, CONFIRM_WINDOW_MINUTES);
    if (!media) throw notFound('Media not found');
    if (media.status !== 'PENDING_UPLOAD') throw conflict(`Media is already ${media.status}`);

    let manifest: CaptureManifest;
    try {
      if (media.expired) throw new Rejection('Upload window has expired');
      if (media.device_revoked) throw new Rejection('Device has been revoked');
      manifest = checkManifest(media, v);
    } catch (err) {
      return reject(user, media, err, ip);
    }

    let claimed: boolean;
    try {
      claimed = await MediaModel.claim(db(), id, { manifest, signature: v.signature, capturedAt: new Date(manifest.capturedAt), lat: manifest.lat, lng: manifest.lng, accuracyM: manifest.accuracyM });
    } catch (err) {
      if (isDuplicateKey(err)) return reject(user, media, new Rejection('This capture has already been uploaded'), ip);
      throw err;
    }
    if (!claimed) throw conflict('Media is already being processed');

    try {
      return await verifyScanAndProcess(user, media, ip);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof Rejection || err instanceof MediaProcessingError) return reject(user, media, err, ip);
      // Infrastructure failure (disk, network): release the claim so the client can retry the confirm.
      await MediaModel.resetToPending(db(), id);
      throw err;
    }
  },

  /** The owner polls this while a video is processing. */
  async getOwn(user: AuthUser, id: string) {
    if (!(await MediaModel.isOwnedBy(db(), id, user.id))) throw notFound('Media not found');
    return MediaModel.ownerView(db(), id);
  },

  /**
   * Attaches the caller's own verified, unattached media to a complaint stage, inside the caller's transaction.
   * Records each item's distance from the complaint location.
   */
  async attach(d: Db, user: AuthUser, complaintId: string, stage: MediaStage, mediaIds: string[] | undefined, rules: AttachRules) {
    const ids = [...new Set(mediaIds ?? [])];
    if (!ids.length) {
      if (rules.requirePhoto) throw badRequest('At least one photo taken in the app is required');
      if (rules.requireAny) throw badRequest('At least one photo or video taken in the app is required');
      return { attached: 0, outsideGeofence: 0 };
    }
    const rows = await MediaModel.lockAttachable(d, ids, user.id);
    if (rows.length !== ids.length) throw badRequest('Some media are not available (not yours, not verified, or already used)');
    const photos = rows.filter((r) => r.kind === 'PHOTO').length;
    const videos = rows.length - photos;
    if (photos > MAX_PER_STAGE.PHOTO || videos > MAX_PER_STAGE.VIDEO) throw badRequest(`At most ${MAX_PER_STAGE.PHOTO} photos and ${MAX_PER_STAGE.VIDEO} video per stage`);
    if (rules.requirePhoto && photos === 0) throw badRequest('At least one photo taken in the app is required');
    if (rules.capturedAfter && rows.some((r) => new Date(r.captured_at) < rules.capturedAfter!)) throw badRequest('Proof must be captured after the complaint was filed');
    return MediaModel.attach(d, ids, complaintId, stage, MEDIA_GEOFENCE_METERS);
  },

  /** Media of a complaint the caller is already authorised to see, with 5-minute signed links. */
  async listForComplaint(complaintId: string, origin: string) {
    const rows = await MediaModel.listForComplaint(db(), complaintId);
    return rows.map((r) => ({
      id: r.id,
      stage: r.stage,
      kind: r.kind,
      status: r.status,
      uploaderRole: r.uploader_role,
      capturedAt: r.captured_at,
      location: { lat: Number(r.lat), lng: Number(r.lng), accuracyM: r.gps_accuracy_m },
      distanceM: r.distance_m === null ? null : Math.round(r.distance_m),
      outsideGeofence: r.outside_geofence === null ? null : !!r.outside_geofence,
      width: r.width,
      height: r.height,
      durationS: r.duration_s,
      bytes: r.bytes_stored,
      url: r.status === 'READY' ? signedFileUrl(origin, r.id, 'main') : null,
      thumbnailUrl: r.status === 'READY' && r.thumb_key ? signedFileUrl(origin, r.id, 'thumb') : null,
    }));
  },

  /** Serves a stored file to anyone holding a valid, unexpired signed link (the link is the authorisation). */
  async serveFile(id: string, variant: string, exp: string, sig: string, rangeHeader: string | null): Promise<Response> {
    if (!verifyFileUrl(id, variant, exp, sig)) throw new HttpError(403, 'This link is invalid or has expired');
    const file = await MediaModel.findFile(db(), id);
    const key = variant === 'thumb' ? file?.thumb_key : file?.object_key;
    if (!file || !key) throw notFound('File not found');
    const head = await Storage.head(key);
    if (!head) throw notFound('File not found');
    const type = variant === 'thumb' ? 'image/jpeg' : file.stored_content_type;

    let start = 0;
    let end = head.size - 1;
    let status = 200;
    const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), head.size - 1) : head.size - 1;
      } else {
        start = Math.max(0, head.size - Number(m[2]));
      }
      if (start > end || start >= head.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
      status = 206;
    }
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-site',
      'Content-Disposition': 'inline',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${head.size}`;
    return new Response(Readable.toWeb(Storage.stream(key, { start, end })) as ReadableStream, { status, headers });
  },

  /** Deletes media never attached to a complaint within 24 h (abandoned or rejected uploads). */
  async purgeOrphans(): Promise<number> {
    const rows = await MediaModel.orphans(db(), ORPHAN_HOURS);
    for (const r of rows) {
      for (const key of [r.staging_key, r.object_key, r.thumb_key]) if (key) await Storage.delete(key).catch(() => undefined);
      await MediaModel.deleteOrphan(db(), r.id);
    }
    return rows.length;
  },

  /** Re-queue videos whose job was lost. Job key = media id, so this is idempotent. */
  async requeueStalledVideos(): Promise<number> {
    const rows = await MediaModel.stalledVideos(db(), 10);
    for (const r of rows) await enqueueVideo(r.id);
    return rows.length;
  },

  /**
   * Bad input (too long, undecodable) is rejected at once; infrastructure errors are thrown so the job queue retries
   * with backoff, and the media is rejected only after the last attempt.
   */
  async processVideoJob(mediaId: string, job: Pick<JobRow, 'attempts' | 'max_attempts'>): Promise<void> {
    const row = await MediaModel.processingVideo(db(), mediaId);
    if (!row) return;
    try {
      const data = await Storage.get(row.staging_key, MAX_BYTES.VIDEO);
      const out = await processVideo(data);
      await store(mediaId, row.staging_key, out.main, out.thumb, 'video/mp4', 'mp4', out);
    } catch (err) {
      const lastAttempt = job.attempts >= job.max_attempts;
      if (!(err instanceof MediaProcessingError) && !lastAttempt) throw err;
      const reason = (err instanceof MediaProcessingError ? err.message : 'Video processing failed').slice(0, 200);
      await db().transaction(async (trx) => {
        await MediaModel.setRejected(trx, mediaId, reason);
        await AuditModel.log(trx, { actorId: row.owner_id, action: 'MEDIA_REJECTED', entity: 'media', entityId: mediaId, meta: { reason } });
        await NotificationService.notify(trx, [row.owner_id], templates.mediaRejected());
      });
      await NotificationService.kick();
      await Storage.delete(row.staging_key).catch(() => undefined);
    }
  },
};

// ---- internals ----

function checkManifest(media: PendingMedia, v: { manifest: string; signature: string }): CaptureManifest {
  const cfg = getConfig().media;
  let manifest: CaptureManifest;
  try {
    manifest = verifyManifest(v.manifest, v.signature, parseDevicePublicKey(media.public_key));
  } catch (err) {
    if (err instanceof ManifestError) throw new Rejection(err.message);
    throw err;
  }
  if (manifest.mediaId !== media.id || manifest.deviceId !== media.device_id) throw new Rejection('Manifest belongs to a different upload');
  if (manifest.kind !== media.kind) throw new Rejection('Manifest kind does not match the upload');
  if (manifest.sha256 !== media.declared_sha256) throw new Rejection('Manifest hash does not match the declared file');
  if (manifest.isMockLocation) throw new Rejection('Mock (fake) GPS location detected');
  if (manifest.accuracyM > cfg.maxGpsAccuracyM) throw new Rejection(`GPS accuracy worse than ${cfg.maxGpsAccuracyM} m`);
  const captured = Date.parse(manifest.capturedAt);
  const now = Date.now();
  if (captured > now + FUTURE_SKEW_MINUTES * 60_000) throw new Rejection('Capture time is in the future');
  if (captured < now - cfg.maxCaptureAgeHours * 3_600_000) throw new Rejection(`Capture is older than ${cfg.maxCaptureAgeHours} hours`);
  return manifest;
}

async function fetchAndVerify(media: PendingMedia): Promise<Buffer> {
  const head = await Storage.head(media.staging_key);
  if (!head) throw new Rejection('File was not uploaded');
  if (head.size !== media.declared_bytes || head.size > MAX_BYTES[media.kind]) throw new Rejection('Uploaded size does not match the declared size');
  const data = await Storage.get(media.staging_key, MAX_BYTES[media.kind]);
  if (createHash('sha256').update(data).digest('hex') !== media.declared_sha256) throw new Rejection('Uploaded file does not match the signed hash');
  const detected = detectType(data);
  const kindOk = media.kind === 'PHOTO' ? detected === 'image/jpeg' || detected === 'image/webp' : detected === 'video/mp4';
  if (!detected || !kindOk) throw new Rejection('File content does not match its declared type');
  return data;
}

async function verifyScanAndProcess(user: AuthUser, media: PendingMedia, ip: string | null) {
  const data = await fetchAndVerify(media);

  let result;
  try {
    result = await scan(data);
  } catch (err) {
    // Fail closed but retryable: put the row back so the client can confirm again.
    console.error('[media] malware scan failed:', (err as Error).message);
    await MediaModel.resetToPending(db(), media.id);
    throw unavailable('Malware scanning is temporarily unavailable; retry shortly');
  }
  if (result.status === 'INFECTED') {
    await AuditModel.log(db(), { actorId: user.id, action: 'MALWARE_DETECTED', entity: 'media', entityId: media.id, ip, meta: { signature: result.signature } });
    throw new Rejection('File failed the malware scan');
  }
  await MediaModel.setScan(db(), media.id, result.status);

  if (media.kind === 'VIDEO') {
    // The upload is accepted either way; a job that cannot be queued now is re-queued by the sweep.
    await enqueueVideo(media.id).catch((err) => console.warn(`[media] video ${media.id} not queued yet:`, (err as Error).message));
    return MediaModel.ownerView(db(), media.id);
  }
  const out = await processPhoto(data);
  await store(media.id, media.staging_key, out.main, out.thumb, 'image/jpeg', 'jpg', { width: out.width, height: out.height, durationS: null });
  return MediaModel.ownerView(db(), media.id);
}

async function store(
  id: string, stagingKey: string, main: Buffer, thumb: Buffer | null, contentType: string, ext: string,
  dims: { width: number | null; height: number | null; durationS: number | null },
) {
  const month = new Date().toISOString().slice(0, 7).replace('-', '/');
  const objectKey = `media/${month}/${id}.${ext}`;
  const thumbKey = thumb ? `media/${month}/${id}.thumb.jpg` : null;
  await Storage.put(objectKey, main);
  if (thumb && thumbKey) await Storage.put(thumbKey, thumb);
  await MediaModel.setReady(db(), id, { objectKey, thumbKey, contentType, bytes: main.length, width: dims.width, height: dims.height, durationS: dims.durationS });
  await Storage.delete(stagingKey).catch(() => undefined);
}

async function reject(user: AuthUser, media: PendingMedia, err: unknown, ip: string | null): Promise<never> {
  if (!(err instanceof Rejection || err instanceof MediaProcessingError)) throw err;
  const reason = err.message.slice(0, 200);
  await MediaModel.setRejected(db(), media.id, reason);
  await Storage.delete(media.staging_key).catch(() => undefined);
  await AuditModel.log(db(), { actorId: user.id, action: 'MEDIA_REJECTED', entity: 'media', entityId: media.id, ip, meta: { reason } });
  throw new HttpError(422, reason, undefined, { mediaStatus: 'REJECTED' });
}

function enqueueVideo(id: string) {
  return JobQueue.add(QUEUES.VIDEO, 'transcode', { mediaId: id }, { dedupeKey: `video-${id}`, maxAttempts: VIDEO_JOB_ATTEMPTS });
}
