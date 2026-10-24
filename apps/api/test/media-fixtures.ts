import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

/**
 * Photo-like test image: smooth gradients, a few edges and fine texture, plus mild sensor noise,
 * which compresses like a real street photo rather than a flat test card.
 */
export async function makePhoto(width = 4000, height = 3000, quality = 97): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const sky = y < height * 0.4;
      const tex = 18 * Math.sin(x / 9) * Math.cos(y / 13) + 10 * Math.sin((x + y) / 31);
      const base = sky ? [120 + (60 * y) / height, 160 + (40 * y) / height, 220] : [110 + tex, 95 + tex * 0.8, 70 + tex * 0.5];
      const pile = (x - width * 0.6) ** 2 / (width * 0.15) ** 2 + (y - height * 0.7) ** 2 / (height * 0.12) ** 2 < 1;
      const c = pile ? [70 + tex * 1.5, 80 + tex, 40 + tex * 0.6] : base;
      const n = rnd() * 12;
      raw[i] = Math.max(0, Math.min(255, c[0] + n));
      raw[i + 1] = Math.max(0, Math.min(255, c[1] + n));
      raw[i + 2] = Math.max(0, Math.min(255, c[2] + n));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .withExif({ IFD0: { Make: 'TestPhone', Model: 'X1', Copyright: 'citizen' } })
    .jpeg({ quality })
    .toBuffer();
}

/** H.264/AAC MP4 from ffmpeg's test sources. */
export function makeVideo(seconds: number, size = '1920x1080', crf = 12): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'cwm-fixture-'));
  try {
    const out = join(dir, 'v.mp4');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-metadata', 'location=+21.2514+081.6296/', out,
    ]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Mean SSIM (8×8 windows, luma) between two images, after scaling both to the same size.
 * 1.0 = identical; ≥ 0.95 is generally indistinguishable to the eye.
 */
export async function ssim(a: Buffer, b: Buffer, size = 512): Promise<number> {
  const load = (img: Buffer) => sharp(img).resize(size, size, { fit: 'fill' }).greyscale().raw().toBuffer();
  const [x, y] = await Promise.all([load(a), load(b)]);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const W = 8;
  let total = 0;
  let windows = 0;
  for (let wy = 0; wy + W <= size; wy += W) {
    for (let wx = 0; wx + W <= size; wx += W) {
      let mx = 0, my = 0;
      for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
        const k = (wy + j) * size + wx + i;
        mx += x[k];
        my += y[k];
      }
      mx /= W * W;
      my /= W * W;
      let vx = 0, vy = 0, cov = 0;
      for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
        const k = (wy + j) * size + wx + i;
        vx += (x[k] - mx) ** 2;
        vy += (y[k] - my) ** 2;
        cov += (x[k] - mx) * (y[k] - my);
      }
      vx /= W * W - 1;
      vy /= W * W - 1;
      cov /= W * W - 1;
      total += ((2 * mx * my + C1) * (2 * cov + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
      windows++;
    }
  }
  return total / windows;
}

/** Same picture, different bytes (random trailer after the JPEG end marker): each real capture is unique. */
export function variant(jpeg: Buffer): Buffer {
  return Buffer.concat([jpeg, Buffer.from(Math.random().toString(36))]);
}
