import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next';
import { extractPolygon } from './geojson';

describe('safeNext (open redirect guard)', () => {
  it.each(['/complaints?status=PENDING', '/complaints/abc#x'])('keeps %s', (p) => expect(safeNext(p)).toBe(p));
  it.each([null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/%2F%2Fevil.example'])(
    'never leaves the portal origin for %p',
    (p) => {
      const out = safeNext(p);
      expect(out.startsWith('/') && !out.startsWith('//')).toBe(true);
      expect(new URL(out, 'https://portal.example').origin).toBe('https://portal.example');
    },
  );
});

describe('extractPolygon', () => {
  const poly = { type: 'Polygon', coordinates: [[[81, 21], [81.1, 21], [81.1, 21.1], [81, 21]]] };
  it('accepts geometry, Feature and single-feature FeatureCollection', () => {
    expect(extractPolygon(JSON.stringify(poly)).type).toBe('Polygon');
    expect(extractPolygon(JSON.stringify({ type: 'Feature', geometry: poly, properties: {} })).type).toBe('Polygon');
    expect(extractPolygon(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: poly }] })).type).toBe('Polygon');
  });
  it('rejects multiple features, points and non-JSON', () => {
    expect(() => extractPolygon(JSON.stringify({ type: 'FeatureCollection', features: [{ geometry: poly }, { geometry: poly }] }))).toThrow(/one polygon/);
    expect(() => extractPolygon(JSON.stringify({ type: 'Point', coordinates: [81, 21] }))).toThrow(/Polygon/);
    expect(() => extractPolygon('<kml/>')).toThrow(/JSON/);
  });
});
