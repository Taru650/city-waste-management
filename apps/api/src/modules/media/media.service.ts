import {
  BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AuthUser } from '../../common/auth-user';
import { mutateReturning } from '../../common/db';
import { Role } from '../../common/enums';
import { AuditService } from '../audit/audit.service';
import { StorageService, UPLOAD_URL_TTL_SECONDS } from '../storage/storage.service';
import { CaptureManifest, ManifestError, parseDevicePublicKey, verifyManifest } from './capture-manifest';
import { ALLOWED_TYPES, ConfirmUploadDto, CreateUploadDto, MAX_BYTES, MediaKind } from './dto/media.dto';
import { detectType } from './file-signature';
import { MalwareScanner } from './malware-scanner';
import { MediaProcessingError, MediaProcessor } from './media-processor';

export enum MediaStage {
  COMPLAINT = 'COMPLAINT',
  WORK_START = 'WORK_START',
  RESOLUTION = 'RESOLUTION',
}

export const MAX_PER_STAGE = { [MediaKind.PHOTO]: 5, [MediaKind.VIDEO]: 1 };
export const MAX_PENDING_UPLOADS = 20;
export const MAX_UPLOADS_PER_DAY = { citizen: 60, staff: 300 };
export const CONFIRM_WINDOW_MINUTES = 30;
export const FUTURE_SKEW_MINUTES = 5;
export const ORPHAN_HOURS = 24;
export const MEDIA_GEOFENCE_METERS = 100;

interface PendingRow {
  id: string;
  kind: MediaKind;
  status: string;
  content_type: string;
  declared_bytes: number;
  declared_sha256: string;
  staging_key: string;
  device_id: string;
  public_key: string;
  device_revoked: boolean;
  expired: boolean;
}

class Rejection extends Error {}

/**
 * Camera-only evidence pipeline:
 *   1. POST /media/upload-url   → pre-signed PUT for one declared file (type, size, sha256)
 *   2. client PUTs the compressed file straight to object storage
 *   3. POST /media/:id/confirm  → signed capture manifest; server verifies signature, freshness,
 *      GPS, hash, real file type, malware; then re-encodes (photo now, video in background)
 *   4. the media id is attached when filing a complaint / starting / resolving work
 */
@Injectable()
export class MediaService implements OnModuleInit {
  private readonly logger = new Logger('Media');
  private readonly queue: string[] = [];
  private running = 0;
  private readonly concurrency = Number(process.env.MEDIA_VIDEO_CONCURRENCY ?? 1);
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly ds: DataSource,
    private readonly storage: StorageService,
    private readonly processor: MediaProcessor,
    private readonly scanner: MalwareScanner,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Resume videos that were mid-processing when the process stopped. */
  async onModuleInit() {
    const rows = await this.ds.query(`SELECT id FROM complaint_media WHERE status = 'PROCESSING' AND kind = 'VIDEO' AND processed_at IS NULL`);
    rows.forEach((r: { id: string }) => this.enqueue(r.id));
  }

  async createUpload(user: AuthUser, dto: CreateUploadDto) {
    if (!ALLOWED_TYPES[dto.kind].includes(dto.contentType)) throw new BadRequestException(`${dto.contentType} is not allowed for ${dto.kind}`);
    if (dto.bytes > MAX_BYTES[dto.kind]) throw new BadRequestException(`${dto.kind} must be at most ${MAX_BYTES[dto.kind]} bytes`);
    const [device] = await this.ds.query(`SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [dto.deviceId, user.id]);
    if (!device) throw new BadRequestException('Unknown or revoked device; register the device again');

    const [counts] = await this.ds.query(
      `SELECT count(*) FILTER (WHERE status = 'PENDING_UPLOAD' AND created_at > now() - make_interval(mins => $2))::int AS pending,
              count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today
         FROM complaint_media WHERE owner_id = $1`,
      [user.id, CONFIRM_WINDOW_MINUTES],
    );
    if (counts.pending >= MAX_PENDING_UPLOADS) throw new HttpException('Too many unfinished uploads', HttpStatus.TOO_MANY_REQUESTS);
    const daily = user.role === Role.CITIZEN ? MAX_UPLOADS_PER_DAY.citizen : MAX_UPLOADS_PER_DAY.staff;
    if (counts.today >= daily) throw new HttpException('Daily upload limit reached', HttpStatus.TOO_MANY_REQUESTS);

    const [row] = await this.ds.query(
      `INSERT INTO complaint_media (owner_id, device_id, kind, status, content_type, declared_bytes, declared_sha256)
       VALUES ($1, $2, $3, 'PENDING_UPLOAD', $4, $5, $6) RETURNING id`,
      [user.id, device.id, dto.kind, dto.contentType, dto.bytes, dto.sha256],
    );
    const stagingKey = `staging/${row.id}`;
    await this.ds.query(`UPDATE complaint_media SET staging_key = $2 WHERE id = $1`, [row.id, stagingKey]);
    const uploadUrl = await this.storage.presignPut(stagingKey, dto.contentType, dto.bytes);
    return {
      mediaId: row.id,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': dto.contentType, 'Content-Length': String(dto.bytes) },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  async confirm(user: AuthUser, id: string, dto: ConfirmUploadDto, ip?: string) {
    const [media]: PendingRow[] = await this.ds.query(
      `SELECT m.id, m.kind, m.status, m.content_type, m.declared_bytes, m.declared_sha256, m.staging_key, m.device_id,
              d.public_key, d.revoked_at IS NOT NULL AS device_revoked,
              m.created_at < now() - make_interval(mins => $3) AS expired
         FROM complaint_media m JOIN devices d ON d.id = m.device_id
        WHERE m.id = $1 AND m.owner_id = $2`,
      [id, user.id, CONFIRM_WINDOW_MINUTES],
    );
    if (!media) throw new NotFoundException('Media not found');
    if (media.status !== 'PENDING_UPLOAD') throw new ConflictException(`Media is already ${media.status}`);

    let manifest: CaptureManifest;
    try {
      if (media.expired) throw new Rejection('Upload window has expired');
      if (media.device_revoked) throw new Rejection('Device has been revoked');
      manifest = this.checkManifest(media, dto);
    } catch (err) {
      return this.reject(user, media, err, ip);
    }

    // Claim the row so a concurrent confirm cannot process it twice.
    let claimed: unknown[];
    try {
      claimed = await mutateReturning(
        this.ds,
        `UPDATE complaint_media SET status = 'PROCESSING', confirmed_at = now(), manifest = $2, signature = $3,
                captured_at = $4, location = ST_SetSRID(ST_MakePoint($6, $5), 4326), gps_accuracy_m = $7
          WHERE id = $1 AND status = 'PENDING_UPLOAD' RETURNING id`,
        [id, manifest, dto.signature, manifest.capturedAt, manifest.lat, manifest.lng, manifest.accuracyM],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return this.reject(user, media, new Rejection('This capture has already been uploaded'), ip);
      throw err;
    }
    if (!claimed.length) throw new ConflictException('Media is already being processed');

    try {
      return await this.verifyScanAndProcess(user, media, ip);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof Rejection || err instanceof MediaProcessingError) return this.reject(user, media, err, ip);
      // Infrastructure failure (storage, network): release the claim so the client can retry the confirm.
      await this.ds.query(`UPDATE complaint_media SET status = 'PENDING_UPLOAD', confirmed_at = NULL WHERE id = $1 AND status = 'PROCESSING'`, [id]);
      throw err;
    }
  }

  private async verifyScanAndProcess(user: AuthUser, media: PendingRow, ip?: string) {
    const data = await this.fetchAndVerify(media);

    let scan;
    try {
      scan = await this.scanner.scan(data);
    } catch (err) {
      // Fail closed but retryable: put the row back so the client can confirm again.
      this.logger.error(`Malware scan failed: ${err}`);
      await this.ds.query(`UPDATE complaint_media SET status = 'PENDING_UPLOAD', confirmed_at = NULL WHERE id = $1`, [media.id]);
      throw new ServiceUnavailableException('Malware scanning is temporarily unavailable; retry shortly');
    }
    if (scan.status === 'INFECTED') {
      await this.audit.log({ actorId: user.id, action: 'MALWARE_DETECTED', entity: 'media', entityId: media.id, ip, meta: { signature: scan.signature } });
      throw new Rejection('File failed the malware scan');
    }
    await this.ds.query(`UPDATE complaint_media SET scan_status = $2 WHERE id = $1`, [media.id, scan.status]);

    if (media.kind === MediaKind.VIDEO) {
      this.enqueue(media.id);
      return this.ownerView(media.id);
    }
    const out = await this.processor.photo(data);
    await this.store(media.id, media.staging_key, out.main, out.thumb, 'image/jpeg', 'jpg', { width: out.width, height: out.height });
    return this.ownerView(media.id);
  }

  /** Owner polls this while a video is processing. */
  async getOwn(user: AuthUser, id: string) {
    const [row] = await this.ds.query(`SELECT id FROM complaint_media WHERE id = $1 AND owner_id = $2`, [id, user.id]);
    if (!row) throw new NotFoundException('Media not found');
    return this.ownerView(id);
  }

  /**
   * Attaches the caller's own verified, unattached media to a complaint stage, inside the
   * caller's transaction. Records each item's distance from the complaint location.
   */
  async attach(
    m: EntityManager,
    user: AuthUser,
    complaintId: string,
    stage: MediaStage,
    mediaIds: string[] | undefined,
    rules: { requireAny?: boolean; requirePhoto?: boolean; capturedAfter?: Date },
  ): Promise<{ attached: number; outsideGeofence: number }> {
    const ids = [...new Set(mediaIds ?? [])];
    if (!ids.length) {
      if (rules.requirePhoto) throw new BadRequestException('At least one photo taken in the app is required');
      if (rules.requireAny) throw new BadRequestException('At least one photo or video taken in the app is required');
      return { attached: 0, outsideGeofence: 0 };
    }
    const rows: { id: string; kind: MediaKind; status: string; captured_at: Date }[] = await m.query(
      `SELECT id, kind, status, captured_at FROM complaint_media
        WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND complaint_id IS NULL
          AND (status = 'READY' OR (status = 'PROCESSING' AND kind = 'VIDEO' AND confirmed_at IS NOT NULL))
        FOR UPDATE`,
      [ids, user.id],
    );
    if (rows.length !== ids.length) throw new BadRequestException('Some media are not available (not yours, not verified, or already used)');
    const photos = rows.filter((r) => r.kind === MediaKind.PHOTO).length;
    const videos = rows.length - photos;
    if (photos > MAX_PER_STAGE.PHOTO || videos > MAX_PER_STAGE.VIDEO) {
      throw new BadRequestException(`At most ${MAX_PER_STAGE.PHOTO} photos and ${MAX_PER_STAGE.VIDEO} video per stage`);
    }
    if (rules.requirePhoto && photos === 0) throw new BadRequestException('At least one photo taken in the app is required');
    if (rules.capturedAfter && rows.some((r) => new Date(r.captured_at) < rules.capturedAfter!)) {
      throw new BadRequestException('Proof must be captured after the complaint was filed');
    }
    const updated = await mutateReturning<{ outside_geofence: boolean }>(
      m,
      `UPDATE complaint_media cm SET complaint_id = c.id, stage = $3, attached_at = now(),
              distance_m = ST_Distance(cm.location::geography, c.location::geography),
              outside_geofence = ST_Distance(cm.location::geography, c.location::geography) > $4
         FROM complaints c
        WHERE c.id = $2 AND cm.id = ANY($1::uuid[])
        RETURNING cm.outside_geofence`,
      [ids, complaintId, stage, MEDIA_GEOFENCE_METERS],
    );
    return { attached: updated.length, outsideGeofence: updated.filter((r) => r.outside_geofence).length };
  }

  /** Media of a complaint the caller is already authorised to see, with 5-minute signed URLs. */
  async listForComplaint(complaintId: string) {
    const rows = await this.ds.query(
      `SELECT cm.id, cm.stage, cm.kind, cm.status, cm.object_key, cm.thumb_key, cm.width, cm.height, cm.duration_s,
              cm.bytes_stored, cm.captured_at, ST_Y(cm.location) AS lat, ST_X(cm.location) AS lng, cm.gps_accuracy_m,
              cm.distance_m, cm.outside_geofence, u.role AS uploader_role
         FROM complaint_media cm JOIN users u ON u.id = cm.owner_id
        WHERE cm.complaint_id = $1 AND cm.status IN ('READY','PROCESSING')
        ORDER BY cm.stage, cm.captured_at`,
      [complaintId],
    );
    return Promise.all(
      rows.map(async (r: Record<string, never>) => ({
        id: r.id,
        stage: r.stage,
        kind: r.kind,
        status: r.status,
        uploaderRole: r.uploader_role,
        capturedAt: r.captured_at,
        location: { lat: Number(r.lat), lng: Number(r.lng), accuracyM: r.gps_accuracy_m },
        distanceM: r.distance_m === null ? null : Math.round(r.distance_m),
        outsideGeofence: r.outside_geofence,
        width: r.width,
        height: r.height,
        durationS: r.duration_s,
        bytes: r.bytes_stored,
        url: r.status === 'READY' ? await this.storage.presignGet(r.object_key) : null,
        thumbnailUrl: r.status === 'READY' ? await this.storage.presignGet(r.thumb_key) : null,
      })),
    );
  }

  /** Deletes media never attached to a complaint within 24 h (abandoned or rejected uploads). */
  async purgeOrphans(): Promise<number> {
    const rows = await this.ds.query(
      `SELECT id, staging_key, object_key, thumb_key FROM complaint_media
        WHERE complaint_id IS NULL AND created_at < now() - make_interval(hours => $1)`,
      [ORPHAN_HOURS],
    );
    for (const r of rows) {
      for (const key of [r.staging_key, r.object_key, r.thumb_key]) if (key) await this.storage.delete(key).catch(() => undefined);
      await this.ds.query(`DELETE FROM complaint_media WHERE id = $1 AND complaint_id IS NULL`, [r.id]);
    }
    return rows.length;
  }

  /** Resolves when no video is queued or processing (used by tests and graceful shutdown). */
  idle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // ---- internals ----

  private checkManifest(media: PendingRow, dto: ConfirmUploadDto): CaptureManifest {
    let manifest: CaptureManifest;
    try {
      manifest = verifyManifest(dto.manifest, dto.signature, parseDevicePublicKey(media.public_key));
    } catch (err) {
      if (err instanceof ManifestError) throw new Rejection(err.message);
      throw err;
    }
    if (manifest.mediaId !== media.id || manifest.deviceId !== media.device_id) throw new Rejection('Manifest belongs to a different upload');
    if (manifest.kind !== media.kind) throw new Rejection('Manifest kind does not match the upload');
    if (manifest.sha256 !== media.declared_sha256) throw new Rejection('Manifest hash does not match the declared file');
    if (manifest.isMockLocation) throw new Rejection('Mock (fake) GPS location detected');
    if (manifest.accuracyM > this.config.media.maxGpsAccuracyM) throw new Rejection(`GPS accuracy worse than ${this.config.media.maxGpsAccuracyM} m`);
    const captured = Date.parse(manifest.capturedAt);
    const now = Date.now();
    if (captured > now + FUTURE_SKEW_MINUTES * 60_000) throw new Rejection('Capture time is in the future');
    if (captured < now - this.config.media.maxCaptureAgeHours * 3_600_000) {
      throw new Rejection(`Capture is older than ${this.config.media.maxCaptureAgeHours} hours`);
    }
    return manifest;
  }

  private async fetchAndVerify(media: PendingRow): Promise<Buffer> {
    const head = await this.storage.head(media.staging_key);
    if (!head) throw new Rejection('File was not uploaded');
    if (head.size !== media.declared_bytes || head.size > MAX_BYTES[media.kind]) throw new Rejection('Uploaded size does not match the declared size');
    const data = await this.storage.get(media.staging_key, MAX_BYTES[media.kind]);
    if (createHash('sha256').update(data).digest('hex') !== media.declared_sha256) throw new Rejection('Uploaded file does not match the signed hash');
    const detected = detectType(data);
    const kindOk = media.kind === MediaKind.PHOTO ? detected === 'image/jpeg' || detected === 'image/webp' : detected === 'video/mp4';
    if (!detected || !kindOk) throw new Rejection('File content does not match its declared type');
    return data;
  }

  private async store(
    id: string, stagingKey: string, main: Buffer, thumb: Buffer, contentType: string, ext: string,
    dims: { width: number; height: number; durationS?: number },
  ) {
    const month = new Date().toISOString().slice(0, 7).replace('-', '/');
    const objectKey = `media/${month}/${id}.${ext}`;
    const thumbKey = `media/${month}/${id}.thumb.jpg`;
    await this.storage.put(objectKey, main, contentType);
    await this.storage.put(thumbKey, thumb, 'image/jpeg');
    await this.ds.query(
      `UPDATE complaint_media SET status = 'READY', object_key = $2, thumb_key = $3, stored_content_type = $4, bytes_stored = $5,
              width = $6, height = $7, duration_s = $8, processed_at = now(), staging_key = NULL
        WHERE id = $1`,
      [id, objectKey, thumbKey, contentType, main.length, dims.width, dims.height, dims.durationS ?? null],
    );
    await this.storage.delete(stagingKey).catch(() => undefined);
  }

  private async reject(user: AuthUser, media: PendingRow, err: unknown, ip?: string): Promise<never> {
    const known = err instanceof Rejection || err instanceof MediaProcessingError;
    if (!known) throw err;
    const reason = (err as Error).message.slice(0, 200);
    await this.ds.query(`UPDATE complaint_media SET status = 'REJECTED', reject_reason = $2 WHERE id = $1`, [media.id, reason]);
    await this.storage.delete(media.staging_key).catch(() => undefined);
    await this.audit.log({ actorId: user.id, action: 'MEDIA_REJECTED', entity: 'media', entityId: media.id, ip, meta: { reason } });
    throw new HttpException({ statusCode: 422, message: reason, mediaStatus: 'REJECTED' }, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private async ownerView(id: string) {
    const [r] = await this.ds.query(
      `SELECT id, kind, status, reject_reason AS "rejectReason", width, height, duration_s AS "durationS",
              declared_bytes AS "uploadedBytes", bytes_stored AS "storedBytes", captured_at AS "capturedAt",
              scan_status AS "scanStatus", complaint_id IS NOT NULL AS attached
         FROM complaint_media WHERE id = $1`,
      [id],
    );
    return r;
  }

  private enqueue(id: string) {
    this.queue.push(id);
    this.pump();
  }

  private pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.running++;
      this.processVideo(id)
        .catch((err) => this.logger.error(`Video ${id} failed: ${err}`))
        .finally(() => {
          this.running--;
          this.pump();
          if (this.running === 0 && this.queue.length === 0) this.idleWaiters.splice(0).forEach((r) => r());
        });
    }
  }

  private async processVideo(id: string) {
    const [row] = await this.ds.query(
      `SELECT id, owner_id, staging_key FROM complaint_media WHERE id = $1 AND status = 'PROCESSING' AND kind = 'VIDEO'`,
      [id],
    );
    if (!row) return;
    try {
      const data = await this.storage.get(row.staging_key, MAX_BYTES.VIDEO);
      const out = await this.processor.video(data);
      await this.store(id, row.staging_key, out.main, out.thumb, 'video/mp4', 'mp4', out);
    } catch (err) {
      const reason = (err instanceof MediaProcessingError ? err.message : 'Video processing failed').slice(0, 200);
      await this.ds.query(`UPDATE complaint_media SET status = 'REJECTED', reject_reason = $2, processed_at = now() WHERE id = $1`, [id, reason]);
      await this.storage.delete(row.staging_key).catch(() => undefined);
      await this.audit.log({ actorId: row.owner_id, action: 'MEDIA_REJECTED', entity: 'media', entityId: id, meta: { reason } });
    }
  }
}
