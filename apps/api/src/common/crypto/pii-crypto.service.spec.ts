import { AppConfig } from '../../config/configuration';
import { PiiCryptoService } from './pii-crypto.service';

const config = { piiEncryptionKey: Buffer.alloc(32, 1), piiHashKey: Buffer.alloc(32, 2) } as AppConfig;

describe('PiiCryptoService', () => {
  const svc = new PiiCryptoService(config);

  it('round-trips and never stores plaintext', () => {
    const enc = svc.encrypt('9876543210');
    expect(enc).not.toContain('9876543210');
    expect(svc.decrypt(enc)).toBe('9876543210');
  });

  it('uses a random IV, so equal values encrypt differently', () => {
    expect(svc.encrypt('a@b.in')).not.toBe(svc.encrypt('a@b.in'));
  });

  it('detects tampering (GCM auth tag)', () => {
    const buf = Buffer.from(svc.encrypt('9876543210'), 'base64');
    buf[buf.length - 1] ^= 0xff;
    expect(() => svc.decrypt(buf.toString('base64'))).toThrow();
  });

  it('blind index is deterministic, case/space-insensitive and key-dependent', () => {
    expect(svc.blindIndex(' A@B.in ')).toBe(svc.blindIndex('a@b.in'));
    const other = new PiiCryptoService({ ...config, piiHashKey: Buffer.alloc(32, 3) } as AppConfig);
    expect(other.blindIndex('a@b.in')).not.toBe(svc.blindIndex('a@b.in'));
  });
});
