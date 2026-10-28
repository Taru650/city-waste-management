import type { Db } from '@/db/sql';
import { POINT_SQL, one, pointParams, query, run } from '@/db/sql';

export type MediaKind = 'PHOTO' | 'VIDEO';
export type MediaStage = 'COMPLAINT' | 'WORK_START' | 'RESOLUTION';

export interface PendingMedia {
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

export interface ManifestFields {
  manifest: unknown;
  signature: string;
  capturedAt: Date;
  lat: number;
  lng: number;
  accuracyM: number;
}

export const MediaModel = {
  async insertPending(d: Db, v: { id: string; ownerId: string; deviceId: string; kind: MediaKind; contentType: string; bytes: number; sha256: string }) {
    await run(
      d,
      `INSERT INTO complaint_media (id, owner_id, device_id, kind, status, content_type, declared_bytes, declared_sha256, staging_key)
       VALUES (?,?,?,?, 'PENDING_UPLOAD', ?,?,?, ?)`,
      [v.id, v.ownerId, v.deviceId, v.kind, v.contentType, v.bytes, v.sha256, `staging/${v.id}`],
    );
  },

  async uploadCounts(d: Db, ownerId: string, windowMinutes: number) {
    const r = await one<{ pending: number; today: number }>(
      d,
      `SELECT COALESCE(SUM(status = 'PENDING_UPLOAD' AND created_at > DATE_SUB(NOW(3), INTERVAL ? MINUTE)), 0) AS pending,
              COALESCE(SUM(created_at > DATE_SUB(NOW(3), INTERVAL 24 HOUR)), 0) AS today
         FROM complaint_media WHERE owner_id = ?`,
      [windowMinutes, ownerId],
    );
    return { pending: Number(r?.pending ?? 0), today: Number(r?.today ?? 0) };
  },

  /** For the upload step: the caller's own media still waiting for its file. */
  async findAwaitingUpload(d: Db, id: string, ownerId: string, windowMinutes: number) {
    const r = await one<{ id: string; status: string; content_type: string; declared_bytes: number; staging_key: string; expired: number }>(
      d,
      `SELECT id, status, content_type, declared_bytes, staging_key, created_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE) AS expired
         FROM complaint_media WHERE id = ? AND owner_id = ?`,
      [windowMinutes, id, ownerId],
    );
    return r && { ...r, expired: !!r.expired };
  },

  async findForConfirm(d: Db, id: string, ownerId: string, windowMinutes: number): Promise<PendingMedia | undefined> {
    const r = await one<Omit<PendingMedia, 'device_revoked' | 'expired'> & { device_revoked: number; expired: number }>(
      d,
      `SELECT m.id, m.kind, m.status, m.content_type, m.declared_bytes, m.declared_sha256, m.staging_key, m.device_id, dv.public_key,
              dv.revoked_at IS NOT NULL AS device_revoked,
              m.created_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE) AS expired
         FROM complaint_media m JOIN devices dv ON dv.id = m.device_id
        WHERE m.id = ? AND m.owner_id = ?`,
      [windowMinutes, id, ownerId],
    );
    return r && { ...r, device_revoked: !!r.device_revoked, expired: !!r.expired };
  },

  /** Claim so a concurrent confirm cannot process the same upload twice. A duplicate checksum raises ER_DUP_ENTRY. */
  async claim(d: Db, id: string, f: ManifestFields): Promise<boolean> {
    const r = await run(
      d,
      `UPDATE complaint_media SET status = 'PROCESSING', confirmed_at = NOW(3), manifest = ?, signature = ?, captured_at = ?,
              location = ${POINT_SQL}, gps_accuracy_m = ?
        WHERE id = ? AND status = 'PENDING_UPLOAD'`,
      [JSON.stringify(f.manifest), f.signature, f.capturedAt, ...pointParams(f.lng, f.lat), f.accuracyM, id],
    );
    return r.affectedRows > 0;
  },

  async resetToPending(d: Db, id: string) {
    await run(d, `UPDATE complaint_media SET status = 'PENDING_UPLOAD', confirmed_at = NULL WHERE id = ? AND status = 'PROCESSING'`, [id]);
  },
  async setScan(d: Db, id: string, scan: string) {
    await run(d, `UPDATE complaint_media SET scan_status = ? WHERE id = ?`, [scan, id]);
  },
  async setReady(
    d: Db,
    id: string,
    v: { objectKey: string; thumbKey: string | null; contentType: string; bytes: number; width: number | null; height: number | null; durationS: number | null },
  ) {
    await run(
      d,
      `UPDATE complaint_media SET status = 'READY', object_key = ?, thumb_key = ?, stored_content_type = ?, bytes_stored = ?,
              width = ?, height = ?, duration_s = ?, processed_at = NOW(3), staging_key = NULL
        WHERE id = ?`,
      [v.objectKey, v.thumbKey, v.contentType, v.bytes, v.width, v.height, v.durationS, id],
    );
  },
  async setRejected(d: Db, id: string, reason: string) {
    await run(d, `UPDATE complaint_media SET status = 'REJECTED', reject_reason = ?, processed_at = NOW(3) WHERE id = ?`, [reason.slice(0, 200), id]);
  },

  ownerView(d: Db, id: string) {
    return one(
      d,
      `SELECT id, kind, status, reject_reason AS rejectReason, width, height, duration_s AS durationS,
              declared_bytes AS uploadedBytes, bytes_stored AS storedBytes, captured_at AS capturedAt,
              scan_status AS scanStatus, (complaint_id IS NOT NULL) AS attached
         FROM complaint_media WHERE id = ?`,
      [id],
    ).then((r) => r && { ...r, attached: !!r.attached });
  },
  async isOwnedBy(d: Db, id: string, ownerId: string): Promise<boolean> {
    return !!(await one(d, `SELECT 1 AS x FROM complaint_media WHERE id = ? AND owner_id = ?`, [id, ownerId]));
  },

  /** The caller's own, verified, not yet attached media (locked for the transaction). */
  lockAttachable(d: Db, ids: string[], ownerId: string) {
    return query<{ id: string; kind: MediaKind; status: string; captured_at: Date }>(
      d,
      `SELECT id, kind, status, captured_at FROM complaint_media
        WHERE id IN (?) AND owner_id = ? AND complaint_id IS NULL
          AND (status = 'READY' OR (status = 'PROCESSING' AND kind = 'VIDEO' AND confirmed_at IS NOT NULL))
        FOR UPDATE`,
      [ids, ownerId],
    );
  },

  /** Attach to a complaint stage and record how far from the complaint it was taken. Returns how many are outside the geofence. */
  async attach(d: Db, ids: string[], complaintId: string, stage: MediaStage, geofenceM: number): Promise<{ attached: number; outsideGeofence: number }> {
    await run(
      d,
      `UPDATE complaint_media cm JOIN complaints c ON c.id = ?
          SET cm.complaint_id = c.id, cm.stage = ?, cm.attached_at = NOW(3),
              cm.distance_m = ST_Distance(cm.location, c.location),
              cm.outside_geofence = (ST_Distance(cm.location, c.location) > ?)
        WHERE cm.id IN (?)`,
      [complaintId, stage, geofenceM, ids],
    );
    const r = await one<{ attached: number; outside: number }>(d, `SELECT COUNT(*) AS attached, COALESCE(SUM(outside_geofence), 0) AS outside FROM complaint_media WHERE id IN (?)`, [ids]);
    return { attached: Number(r?.attached ?? 0), outsideGeofence: Number(r?.outside ?? 0) };
  },

  listForComplaint(d: Db, complaintId: string) {
    return query(
      d,
      `SELECT cm.id, cm.stage, cm.kind, cm.status, cm.object_key, cm.thumb_key, cm.width, cm.height, cm.duration_s,
              cm.bytes_stored, cm.captured_at, ST_Latitude(cm.location) AS lat, ST_Longitude(cm.location) AS lng, cm.gps_accuracy_m,
              cm.distance_m, cm.outside_geofence, u.role AS uploader_role
         FROM complaint_media cm JOIN users u ON u.id = cm.owner_id
        WHERE cm.complaint_id = ? AND cm.status IN ('READY','PROCESSING')
        ORDER BY cm.stage, cm.captured_at, cm.id`,
      [complaintId],
    );
  },

  /** For serving a file: only READY media has one. */
  findFile(d: Db, id: string) {
    return one<{ object_key: string; thumb_key: string | null; stored_content_type: string; complaint_id: string | null }>(
      d,
      `SELECT object_key, thumb_key, stored_content_type, complaint_id FROM complaint_media WHERE id = ? AND status = 'READY'`,
      [id],
    );
  },

  orphans(d: Db, hours: number) {
    return query<{ id: string; staging_key: string | null; object_key: string | null; thumb_key: string | null }>(
      d,
      `SELECT id, staging_key, object_key, thumb_key FROM complaint_media
        WHERE complaint_id IS NULL AND created_at < DATE_SUB(NOW(3), INTERVAL ? HOUR)`,
      [hours],
    );
  },
  async deleteOrphan(d: Db, id: string) {
    await run(d, `DELETE FROM complaint_media WHERE id = ? AND complaint_id IS NULL`, [id]);
  },
  stalledVideos(d: Db, minutes: number) {
    return query<{ id: string }>(d, `SELECT id FROM complaint_media WHERE status = 'PROCESSING' AND kind = 'VIDEO' AND processed_at IS NULL AND confirmed_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE)`, [minutes]);
  },
  processingVideo(d: Db, id: string) {
    return one<{ id: string; owner_id: string; staging_key: string }>(d, `SELECT id, owner_id, staging_key FROM complaint_media WHERE id = ? AND status = 'PROCESSING' AND kind = 'VIDEO'`, [id]);
  },
};
