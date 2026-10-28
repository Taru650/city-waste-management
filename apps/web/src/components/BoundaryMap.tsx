'use client';

import type { GeoJsonObject } from 'geojson';
import L from 'leaflet';
import { useEffect } from 'react';
import { GeoJSON, MapContainer, TileLayer, useMap } from 'react-leaflet';

function Fit({ data }: { data: GeoJsonObject }) {
  const map = useMap();
  useEffect(() => {
    const b = L.geoJSON(data).getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [16, 16] });
  }, [data, map]);
  return null;
}

/** Ward boundaries (existing in grey, a new upload highlighted in green) for checking before saving. */
export default function BoundaryMap({ existing, preview, tileUrl }: { existing?: GeoJsonObject; preview?: GeoJsonObject; tileUrl: string }) {
  return (
    <MapContainer center={[21.25, 81.63]} zoom={12} style={{ height: 380 }}>
      <TileLayer url={tileUrl} attribution="&copy; OpenStreetMap contributors" />
      {existing && <GeoJSON key={JSON.stringify(existing).length} data={existing} style={{ color: '#555', weight: 1, fillOpacity: 0.08 }}
        onEachFeature={(f, layer) => layer.bindTooltip(`Ward ${f.properties?.number}${f.properties?.name ? ` · ${f.properties.name}` : ''}`)} />}
      {preview && <GeoJSON key={`p${JSON.stringify(preview).length}`} data={preview} style={{ color: '#1f7a4d', weight: 3, fillOpacity: 0.25 }} />}
      {(preview ?? existing) && <Fit data={(preview ?? existing)!} />}
    </MapContainer>
  );
}
