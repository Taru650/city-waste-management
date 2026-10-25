import sharp from 'sharp';
import { AppConfig } from '../../config/configuration';
import { makePhoto, makeVideo, ssim } from '../../../test/media-fixtures';
import { MediaProcessingError, MediaProcessor } from './media-processor';

const configFor = (photoEncoder: 'turbo' | 'mozjpeg') =>
  ({ media: { videoMaxSeconds: 30, videoPreset: 'ultrafast', maxCaptureAgeHours: 24, maxGpsAccuracyM: 100, photoEncoder } }) as AppConfig;

describe.each(['turbo', 'mozjpeg'] as const)('MediaProcessor (%s)', (encoder) => {
  const processor = new MediaProcessor(configFor(encoder));

  describe('photos', () => {
    let original: Buffer;
    beforeAll(async () => {
      original = await makePhoto(4000, 3000, 97); // like an uncompressed 12 MP phone photo
    });

    it('shrinks a 12 MP photo to ≤ 1920 px and a fraction of the size without visible loss', async () => {
      const out = await processor.photo(original);
      expect(Math.max(out.width, out.height)).toBe(1920);
      expect(out.main.length).toBeLessThan(original.length * 0.25);
      const score = await ssim(original, out.main);
      // eslint-disable-next-line no-console
      console.info(`photo ${(original.length / 1e6).toFixed(2)} MB → ${(out.main.length / 1e3).toFixed(0)} KB, SSIM ${score.toFixed(4)}`);
      expect(score).toBeGreaterThanOrEqual(0.95);
    });

    it('re-encoding an already app-compressed photo loses almost nothing (no generation loss)', async () => {
      const appCompressed = await sharp(original).resize(1920).jpeg({ quality: 80 }).toBuffer();
      const out = await processor.photo(appCompressed);
      expect(await ssim(appCompressed, out.main)).toBeGreaterThanOrEqual(0.97);
      expect(out.main.length).toBeLessThan(appCompressed.length * 1.3);
    });

    it('strips all metadata (EXIF, GPS) from stored copies', async () => {
      expect((await sharp(original).metadata()).exif).toBeDefined();
      const out = await processor.photo(original);
      expect((await sharp(out.main).metadata()).exif).toBeUndefined();
      expect((await sharp(out.thumb).metadata()).exif).toBeUndefined();
    });

    it('makes a ≤ 320 px thumbnail', async () => {
      const meta = await sharp((await processor.photo(original)).thumb).metadata();
      expect(Math.max(meta.width!, meta.height!)).toBe(320);
    });

    it('never upscales small photos', async () => {
      const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#557' } }).jpeg().toBuffer();
      const out = await processor.photo(small);
      expect([out.width, out.height]).toEqual([800, 600]);
    });

    it('refuses decompression bombs (> 40 MP) and corrupt files', async () => {
      const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#000' } }).jpeg({ quality: 10 }).toBuffer();
      await expect(processor.photo(bomb)).rejects.toThrow(MediaProcessingError);
      const corrupt = Buffer.concat([original.subarray(0, 2000), Buffer.alloc(2000)]);
      await expect(processor.photo(corrupt)).rejects.toThrow(MediaProcessingError);
    });
  });

  describe('video', () => {
    it('transcodes 1080p to 720p H.264, keeps duration, shrinks it and strips metadata', async () => {
      const input = makeVideo(4);
      const out = await processor.video(input);
      expect(Math.min(out.width, out.height)).toBe(720);
      expect(out.durationS).toBeGreaterThan(3.5);
      expect(out.durationS).toBeLessThan(4.6);
      expect(out.main.length).toBeLessThan(input.length * 0.5);
      expect(out.main.includes(Buffer.from('+21.2514'))).toBe(false);
      expect((await sharp(out.thumb).metadata()).format).toBe('jpeg');
      // eslint-disable-next-line no-console
      console.info(`video ${(input.length / 1e6).toFixed(2)} MB → ${(out.main.length / 1e6).toFixed(2)} MB`);
    }, 120_000);

    it('keeps portrait orientation with the short edge at 720', async () => {
      const out = await processor.video(makeVideo(2, '1080x1920'));
      expect([out.width, out.height]).toEqual([720, 1280]);
    }, 120_000);

    it('rejects videos longer than the limit and non-video files', async () => {
      await expect(processor.video(makeVideo(32, '320x240', 30))).rejects.toThrow(/longer than 30 seconds/);
      await expect(processor.video(Buffer.from('not a video at all'))).rejects.toThrow(MediaProcessingError);
    }, 120_000);
  });
});
