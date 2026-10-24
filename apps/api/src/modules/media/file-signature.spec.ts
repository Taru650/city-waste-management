import { detectType } from './file-signature';

describe('detectType (magic bytes)', () => {
  it.each([
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]), 'image/webp'],
    [Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(8)]), 'video/mp4'],
    [Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypmp42'), Buffer.alloc(8)]), 'video/mp4'],
  ])('recognises %p', (buf, type) => {
    expect(detectType(buf)).toBe(type);
  });

  it.each([
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['HTML', Buffer.from('<html><script>alert(1)</script>')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['PDF', Buffer.from('%PDF-1.7')],
    ['ELF', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    ['HEIC', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)])],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s', (_name, buf) => {
    expect(detectType(buf)).toBeNull();
  });
});
