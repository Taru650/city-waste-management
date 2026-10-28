import { generateKeyPairSync, sign, createHash, randomBytes, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { POST as registerDevice } from '@/app/api/v1/devices/route';
import { POST as createUpload } from '@/app/api/v1/media/upload-url/route';
import { PUT as putContent } from '@/app/api/v1/media/[id]/content/route';
import { POST as confirmRoute } from '@/app/api/v1/media/[id]/confirm/route';
import type { CaptureManifest } from '@/lib/captureManifest';
import { call, type Reply, type TestUser } from './helpers';

export interface TestDevice {
  id: string;
  privateKey: KeyObject;
  publicKey: string;
}

export function newKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

export async function makeDevice(token: string): Promise<TestDevice> {
  const { privateKey, publicKey } = newKeyPair();
  const res = await call(registerDevice, 'POST', '/api/v1/devices', { token, body: { publicKey, platform: 'ANDROID', appVersion: '1.0.0' } });
  if (res.status !== 201) throw new Error(`device registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id, privateKey, publicKey };
}

/** A real JPEG that is different every time (random colour), so its checksum is unique. */
export async function makeJpeg(width = 640, height = 480): Promise<Buffer> {
  const [r, g, b] = randomBytes(3);
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
}
export async function makeWebp(width = 320, height = 240): Promise<Buffer> {
  const [r, g, b] = randomBytes(3);
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).webp().toBuffer();
}

export function hasTool(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A real MP4 (H.264) of the given length, made with ffmpeg; the test is skipped where ffmpeg is missing. */
export function makeMp4(seconds = 2): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'cwm-test-mp4-'));
  try {
    const out = path.join(dir, 'in.mp4');
    const colour = randomBytes(3).toString('hex');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${colour}:s=160x120:r=5:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function signManifest(privateKey: KeyObject, manifest: unknown): { manifest: string; signature: string } {
  const raw = Buffer.from(JSON.stringify(manifest));
  return { manifest: raw.toString('base64url'), signature: sign('sha256', raw, { key: privateKey, dsaEncoding: 'der' }).toString('base64') };
}

export interface UploadOptions {
  kind?: 'PHOTO' | 'VIDEO';
  contentType?: string;
  /** What is declared and signed (default: the real bytes). */
  declaredBytes?: number;
  declaredSha?: string;
  /** What is actually sent (default: the same bytes). */
  sent?: Buffer;
  lat?: number;
  lng?: number;
  accuracyM?: number;
  capturedAt?: Date;
  mock?: boolean;
  /** Change the manifest after the ids are known (mediaId, deviceId...). */
  tweak?: (m: CaptureManifest) => CaptureManifest;
  /** Sign with a different key. */
  signWith?: KeyObject;
  skipPut?: boolean;
  skipConfirm?: boolean;
}

export interface UploadResult {
  mediaId: string;
  declared: Reply;
  put?: Reply;
  confirm?: Reply;
}

/** The whole camera-evidence flow as an app does it: declare, PUT the bytes, confirm with a signed manifest. */
export async function uploadMedia(token: string, device: TestDevice, data: Buffer, o: UploadOptions = {}): Promise<UploadResult> {
  const kind = o.kind ?? 'PHOTO';
  const contentType = o.contentType ?? (kind === 'PHOTO' ? 'image/jpeg' : 'video/mp4');
  const declared = await call(createUpload, 'POST', '/api/v1/media/upload-url', {
    token,
    body: { deviceId: device.id, kind, contentType, bytes: o.declaredBytes ?? data.length, sha256: o.declaredSha ?? sha256(data) },
  });
  if (declared.status !== 201) return { mediaId: '', declared };
  const mediaId: string = declared.body.mediaId;
  const result: UploadResult = { mediaId, declared };
  if (!o.skipPut) {
    const sent = o.sent ?? data;
    result.put = await call(putContent, 'PUT', `/api/v1/media/${mediaId}/content`, { token, params: { id: mediaId }, rawBytes: sent, headers: { 'content-type': contentType } });
  }
  if (!o.skipConfirm) {
    let manifest: CaptureManifest = {
      v: 1, mediaId, deviceId: device.id, kind, sha256: o.declaredSha ?? sha256(data),
      capturedAt: (o.capturedAt ?? new Date()).toISOString(), lat: o.lat ?? 21.25, lng: o.lng ?? 81.63,
      accuracyM: o.accuracyM ?? 8, isMockLocation: o.mock ?? false,
    };
    if (o.tweak) manifest = o.tweak(manifest);
    const signed = signManifest(o.signWith ?? device.privateKey, manifest);
    result.confirm = await call(confirmRoute, 'POST', `/api/v1/media/${mediaId}/confirm`, { token, params: { id: mediaId }, body: signed });
  }
  return result;
}

export type { TestUser };
