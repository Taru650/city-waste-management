/**
 * Identify uploads by their leading bytes, never by the declared content type or file name.
 * Only the formats the apps produce are accepted.
 */
export type DetectedType = 'image/jpeg' | 'image/webp' | 'video/mp4';

export function detectType(buf: Buffer): DetectedType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  // ISO base media: [size][ftyp][brand]. Accept MP4 / QuickTime-compatible brands written by phone cameras.
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'qt  ', '3gp4', '3gp5', 'dash'].includes(brand)) return 'video/mp4';
  }
  return null;
}
