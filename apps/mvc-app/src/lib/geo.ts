import { z } from 'zod';

/** A GeoJSON Polygon or MultiPolygon in WGS84 (longitude, latitude). Structure only; topology is checked by MySQL. */
export interface GeoJsonPolygon {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
}

const MAX_VERTICES = 50_000;

const isPosition = (p: unknown): boolean =>
  Array.isArray(p) &&
  p.length >= 2 &&
  p.length <= 3 &&
  p.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
  Math.abs(p[0] as number) <= 180 &&
  Math.abs(p[1] as number) <= 90;

function ringsOk(rings: unknown, counter: { n: number }): boolean {
  if (!Array.isArray(rings) || rings.length === 0) return false;
  return rings.every((ring) => {
    if (!Array.isArray(ring) || ring.length < 4) return false;
    counter.n += ring.length;
    return counter.n <= MAX_VERTICES && ring.every(isPosition);
  });
}

export function isGeoJsonPolygon(value: unknown): value is GeoJsonPolygon {
  if (!value || typeof value !== 'object') return false;
  const v = value as GeoJsonPolygon;
  const counter = { n: 0 };
  if (v.type === 'Polygon') return ringsOk(v.coordinates, counter);
  if (v.type === 'MultiPolygon') return Array.isArray(v.coordinates) && v.coordinates.length > 0 && v.coordinates.every((poly) => ringsOk(poly, counter));
  return false;
}

export const geoJsonPolygon = z.custom<GeoJsonPolygon>(isGeoJsonPolygon, { message: 'must be a GeoJSON Polygon or MultiPolygon (lng/lat, WGS84)' });

/** Square polygon of `size` degrees with its south-west corner at (lat, lng): used by the demo seeders and tests. */
export function square(lat: number, lng: number, size = 0.01): GeoJsonPolygon {
  return { type: 'Polygon', coordinates: [[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]] };
}
