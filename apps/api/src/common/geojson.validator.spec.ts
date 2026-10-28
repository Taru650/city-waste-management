import { isGeoJsonPolygon } from './geojson.validator';

const ring = [[81.6, 21.2], [81.61, 21.2], [81.61, 21.21], [81.6, 21.21], [81.6, 21.2]];

describe('isGeoJsonPolygon', () => {
  it('accepts Polygon and MultiPolygon', () => {
    expect(isGeoJsonPolygon({ type: 'Polygon', coordinates: [ring] })).toBe(true);
    expect(isGeoJsonPolygon({ type: 'MultiPolygon', coordinates: [[ring]] })).toBe(true);
  });

  it.each([
    null, 'x', { type: 'Point', coordinates: [81.6, 21.2] }, { type: 'Polygon', coordinates: [] },
    { type: 'Polygon', coordinates: [[[81.6, 21.2], [81.61, 21.2], [81.6, 21.2]]] },
    { type: 'Polygon', coordinates: [[[181, 21.2], [81.61, 21.2], [81.61, 21.21], [181, 21.2]]] },
    { type: 'Polygon', coordinates: [[['81.6', 21.2], [81.61, 21.2], [81.61, 21.21], ['81.6', 21.2]]] },
  ])('rejects %p', (v) => {
    expect(isGeoJsonPolygon(v)).toBe(false);
  });

  it('caps the vertex count', () => {
    const big = Array.from({ length: 50_001 }, (_, i) => [81 + i * 1e-6, 21]);
    expect(isGeoJsonPolygon({ type: 'Polygon', coordinates: [big] })).toBe(false);
  });
});
