import { generateKeyPairSync, sign } from 'crypto';
import { keyFingerprint, ManifestError, parseDevicePublicKey, verifyManifest } from './capture-manifest';

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = ec.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const manifest = {
  v: 1, mediaId: 'm1', deviceId: 'd1', kind: 'PHOTO', sha256: 'a'.repeat(64),
  capturedAt: new Date().toISOString(), lat: 21.25, lng: 81.63, accuracyM: 8, isMockLocation: false,
};
const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const signB64 = (b64url: string, key = ec.privateKey) => sign('sha256', Buffer.from(b64url, 'base64url'), key).toString('base64');

describe('capture manifest', () => {
  it('verifies a signature from the registered device key', () => {
    const m = encode(manifest);
    expect(verifyManifest(m, signB64(m), parseDevicePublicKey(spki))).toEqual(manifest);
  });

  it('rejects a signature from another key', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const m = encode(manifest);
    expect(() => verifyManifest(m, signB64(m, other.privateKey), parseDevicePublicKey(spki))).toThrow(/signature is invalid/);
  });

  it('rejects any change to the signed bytes', () => {
    const m = encode(manifest);
    const sig = signB64(m);
    const tampered = encode({ ...manifest, lat: 21.26 });
    expect(() => verifyManifest(tampered, sig, parseDevicePublicKey(spki))).toThrow(ManifestError);
  });

  it.each([
    [{ v: 2 }], [{ kind: 'AUDIO' }], [{ sha256: 'xyz' }], [{ capturedAt: 'yesterday' }], [{ lat: 95 }], [{ lng: '81' }],
    [{ isMockLocation: 'no' }], [{ accuracyM: -1 }],
  ])('rejects a correctly signed but malformed manifest %p', (override) => {
    const m = encode({ ...manifest, ...override });
    expect(() => verifyManifest(m, signB64(m), parseDevicePublicKey(spki))).toThrow(/missing or invalid/);
  });

  it('accepts only EC P-256 public keys', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(() => parseDevicePublicKey(rsa)).toThrow(/P-256/);
    expect(() => parseDevicePublicKey(p384)).toThrow(/P-256/);
    expect(() => parseDevicePublicKey('bm90IGEga2V5')).toThrow(/SPKI/);
  });

  it('fingerprints keys deterministically', () => {
    expect(keyFingerprint(spki)).toMatch(/^[a-f0-9]{64}$/);
    expect(keyFingerprint(spki)).toBe(keyFingerprint(spki));
  });
});
