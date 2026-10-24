import { Inject, Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

export const PHOTO_MAX_EDGE = 1920;
export const PHOTO_QUALITY = 82;
export const THUMB_EDGE = 320;
/** Decompression-bomb guard: refuse images above 40 megapixels before decoding them. */
export const MAX_INPUT_PIXELS = 40_000_000;
export const VIDEO_SHORT_EDGE = 720;
export const VIDEO_CRF = 26;
const FFMPEG_TIMEOUT_MS = 180_000;

export class MediaProcessingError extends Error {}

export interface ProcessedPhoto {
  main: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
}

export interface ProcessedVideo {
  main: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
  durationS: number;
}

/**
 * Server-side normalisation after the app's own compression ("visually lossless"):
 * - photos: auto-rotate, fit within 1920 px, mozjpeg q82, all metadata (EXIF/GPS) stripped;
 * - video: H.264 CRF 26, short edge ≤ 720 px, AAC 64 kbps mono, faststart, metadata stripped.
 */
@Injectable()
export class MediaProcessor {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async photo(input: Buffer): Promise<ProcessedPhoto> {
    try {
      const base = sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).rotate();
      const main = await base
        .clone()
        .resize({ width: PHOTO_MAX_EDGE, height: PHOTO_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: PHOTO_QUALITY, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      const thumb = await base
        .clone()
        .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70, mozjpeg: true })
        .toBuffer();
      return { main: main.data, thumb, width: main.info.width, height: main.info.height };
    } catch (err) {
      throw new MediaProcessingError(`Image could not be processed: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  async video(input: Buffer): Promise<ProcessedVideo> {
    const dir = await mkdtemp(join(tmpdir(), 'cwm-video-'));
    try {
      const src = join(dir, 'in');
      const out = join(dir, 'out.mp4');
      const thumbPath = join(dir, 'thumb.jpg');
      await writeFile(src, input);

      const probe = await this.probe(src);
      if (!probe.hasVideo) throw new MediaProcessingError('No video stream found');
      if (!(probe.durationS > 0)) throw new MediaProcessingError('Could not read video duration');
      if (probe.durationS > this.config.media.videoMaxSeconds + 0.5) {
        throw new MediaProcessingError(`Video is longer than ${this.config.media.videoMaxSeconds} seconds`);
      }
      const even = (e: string) => `trunc(${e}/2)*2`;
      await run('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
        '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
        '-t', String(this.config.media.videoMaxSeconds + 1),
        '-vf', `scale=w='if(gt(iw,ih),-2,${even(`min(${VIDEO_SHORT_EDGE},iw)`)})':h='if(gt(iw,ih),${even(`min(${VIDEO_SHORT_EDGE},ih)`)},-2)'`,
        '-c:v', 'libx264', '-preset', this.config.media.videoPreset, '-crf', String(VIDEO_CRF), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart', out,
      ]);
      await run('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(0.5, probe.durationS / 2)), '-i', out,
        '-frames:v', '1', '-vf', `scale=${THUMB_EDGE}:-2`, thumbPath,
      ]);
      const result = await this.probe(out);
      return {
        main: await readFile(out),
        thumb: await sharp(await readFile(thumbPath)).jpeg({ quality: 70, mozjpeg: true }).toBuffer(),
        width: result.width,
        height: result.height,
        durationS: result.durationS,
      };
    } catch (err) {
      if (err instanceof MediaProcessingError) throw err;
      throw new MediaProcessingError(`Video could not be processed: ${(err as Error).message.slice(0, 120)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async probe(path: string) {
    const json = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
    const info = JSON.parse(json) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
    const video = info.streams?.find((s) => s.codec_type === 'video');
    return { hasVideo: !!video, width: video?.width ?? 0, height: video?.height ?? 0, durationS: Number(info.format?.duration ?? 0) };
  }
}

/** Runs a binary with an argument array (no shell, so no injection) and a hard timeout. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}`));
    });
  });
}
