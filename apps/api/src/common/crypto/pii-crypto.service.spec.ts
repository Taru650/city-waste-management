import { AppConfig } from '../../config/configuration';
import { PiiCryptoService } from './pii-crypto.service';

const config = { piiEncryptionKey: Buffer.alloc(32, 1), piiHashKey: Buffer.alloc(32, 2), piiEncryptionKeyPrevious: null, piiHashKeyPrevious: null } as AppConfig;

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

  describe('key rotation', () => {
    const rotated = new PiiCryptoService({
      ...config, piiEncryptionKey: Buffer.alloc(32, 4), piiHashKey: Buffer.alloc(32, 5),
      piiEncryptionKeyPrevious: config.piiEncryptionKey, piiHashKeyPrevious: config.piiHashKey,
    } as AppConfig);
    const newOnly = new PiiCryptoService({ ...config, piiEncryptionKey: Buffer.alloc(32, 4), piiHashKey: Buffer.alloc(32, 5) } as AppConfig);

    it('reads values written under the previous key and says they need re-encryption; writes only under the new key', () => {
      const old = svc.encrypt('9876543210');
      expect(rotated.decrypt(old)).toBe('9876543210');
      expect(rotated.isCurrent(old)).toBe(false);
      const fresh = rotated.encrypt('9876543210');
      expect(rotated.isCurrent(fresh)).toBe(true);
      expect(newOnly.decrypt(fresh)).toBe('9876543210');
      expect(() => svc.decrypt(fresh)).toThrow();
    });

    it('lookups match both indexes during the rotation, writes use the new one', () => {
      expect(rotated.blindIndexes('a@b.in')).toEqual([newOnly.blindIndex('a@b.in'), svc.blindIndex('a@b.in')]);
      expect(rotated.blindIndex('a@b.in')).toBe(newOnly.blindIndex('a@b.in'));
      expect(svc.blindIndexes('a@b.in')).toEqual([svc.blindIndex('a@b.in')]);
    });

    it('once the previous key is removed, old values are unreadable (the rotation job must have run)', () => {
      expect(() => newOnly.decrypt(svc.encrypt('x'))).toThrow();
    });
  });
});
