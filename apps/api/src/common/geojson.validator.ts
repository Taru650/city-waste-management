import { registerDecorator, ValidationOptions } from 'class-validator';

export interface GeoJsonPolygon {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
}

const MAX_VERTICES = 50_000;

function isPosition(p: unknown): boolean {
  return (
    Array.isArray(p) && p.length >= 2 && p.length <= 3 &&
    p.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    Math.abs(p[0] as number) <= 180 && Math.abs(p[1] as number) <= 90
  );
}

function ringsOk(rings: unknown, counter: { n: number }): boolean {
  if (!Array.isArray(rings) || rings.length === 0) return false;
  return rings.every((ring) => {
    if (!Array.isArray(ring) || ring.length < 4) return false;
    counter.n += ring.length;
    return counter.n <= MAX_VERTICES && ring.every(isPosition);
  });
}

/** Structural check of a GeoJSON Polygon/MultiPolygon in WGS84; topology is validated again by PostGIS. */
export function isGeoJsonPolygon(value: unknown): value is GeoJsonPolygon {
  if (!value || typeof value !== 'object') return false;
  const v = value as GeoJsonPolygon;
  const counter = { n: 0 };
  if (v.type === 'Polygon') return ringsOk(v.coordinates, counter);
  if (v.type === 'MultiPolygon') {
    return Array.isArray(v.coordinates) && v.coordinates.length > 0 && v.coordinates.every((poly) => ringsOk(poly, counter));
  }
  return false;
}

export function IsGeoJsonPolygon(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isGeoJsonPolygon',
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} must be a GeoJSON Polygon or MultiPolygon (lng/lat, WGS84)`, ...options },
      validator: { validate: isGeoJsonPolygon },
    });
}
