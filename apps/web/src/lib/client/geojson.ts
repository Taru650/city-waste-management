export interface PolygonGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
}

/**
 * Accepts what ULB GIS teams usually export: a bare Polygon/MultiPolygon geometry, a Feature,
 * or a FeatureCollection with exactly one polygon feature. Returns the geometry to upload.
 */
export function extractPolygon(text: string): PolygonGeometry {
  let obj: { type?: string; geometry?: unknown; features?: { geometry?: unknown }[] };
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON/GeoJSON');
  }
  let geom: unknown = obj;
  if (obj.type === 'FeatureCollection') {
    const polys = (obj.features ?? []).filter((f) => ['Polygon', 'MultiPolygon'].includes((f.geometry as PolygonGeometry)?.type));
    if (polys.length !== 1) throw new Error(`Expected one polygon feature, found ${polys.length}. Upload one ward per file.`);
    geom = polys[0].geometry;
  } else if (obj.type === 'Feature') {
    geom = obj.geometry;
  }
  const g = geom as PolygonGeometry;
  if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) throw new Error('Geometry must be a Polygon or MultiPolygon');
  return { type: g.type, coordinates: g.coordinates };
}
