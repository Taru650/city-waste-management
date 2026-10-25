import { checkPayload, deviceVerdict, IntegrityPayload } from './play-integrity';

const now = 1_800_000_000_000;
const good = (o: Partial<{ nonce: string; ts: number; app: string; pkg: string; cert: string[]; device: string[] }> = {}): IntegrityPayload => ({
  requestDetails: { requestPackageName: o.pkg ?? 'org.x', nonce: o.nonce ?? 'n1', timestampMillis: String(o.ts ?? now - 1000) },
  appIntegrity: { appRecognitionVerdict: o.app ?? 'PLAY_RECOGNIZED', packageName: o.pkg ?? 'org.x', certificateSha256Digest: o.cert ?? ['c1'] },
  deviceIntegrity: { deviceRecognitionVerdict: o.device ?? ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY'] },
});
const expected = { packageName: 'org.x', nonce: 'n1', certSha256: ['c1'], minLevel: 'DEVICE' as const, now };

describe('Play Integrity verdict checks', () => {
  it('accepts a matching, fresh, Play-recognised verdict and reports the strongest device label', () => {
    expect(checkPayload(good(), expected)).toBe('MEETS_DEVICE_INTEGRITY');
    expect(checkPayload(good({ device: ['MEETS_STRONG_INTEGRITY', 'MEETS_DEVICE_INTEGRITY'] }), expected)).toBe('MEETS_STRONG_INTEGRITY');
  });

  it.each([
    ['another package', good({ pkg: 'org.evil' }), /package/],
    ['another nonce', good({ nonce: 'n2' }), /nonce/],
    ['an old token', good({ ts: now - 11 * 60_000 }), /old/],
    ['a token from the future', good({ ts: now + 5 * 60_000 }), /old/],
    ['a missing timestamp', { ...good(), requestDetails: { requestPackageName: 'org.x', nonce: 'n1' } }, /old/],
    ['an unrecognised app', good({ app: 'UNRECOGNIZED_VERSION' }), /app/],
    ['an unevaluated app', good({ app: 'UNEVALUATED' }), /app/],
    ['an unknown signing certificate', good({ cert: ['c9'] }), /certificate/],
    ['basic integrity when device is required', good({ device: ['MEETS_BASIC_INTEGRITY'] }), /device/],
    ['no device labels', good({ device: [] }), /device/],
  ])('rejects %s', (_l, payload, reason) => {
    expect(() => checkPayload(payload as IntegrityPayload, expected)).toThrow(reason);
  });

  it('BASIC accepts basic integrity; an empty certificate list skips the certificate check (non-production)', () => {
    expect(checkPayload(good({ device: ['MEETS_BASIC_INTEGRITY'] }), { ...expected, minLevel: 'BASIC' })).toBe('MEETS_BASIC_INTEGRITY');
    expect(checkPayload(good({ cert: ['anything'] }), { ...expected, certSha256: [] })).toBe('MEETS_DEVICE_INTEGRITY');
  });

  it('deviceVerdict tolerates missing sections', () => {
    expect(deviceVerdict({})).toBe('NONE');
  });
});
