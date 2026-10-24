'use client';

import { CircleMarker, MapContainer, TileLayer, Tooltip } from 'react-leaflet';

export interface MapPoint {
  lat: number;
  lng: number;
  label: string;
  color: string;
}

export default function PointMap({ points, tileUrl, height = 260 }: { points: MapPoint[]; tileUrl: string; height?: number }) {
  const c = points[0] ?? { lat: 21.25, lng: 81.63 };
  return (
    <MapContainer center={[c.lat, c.lng]} zoom={17} style={{ height }} scrollWheelZoom={false}>
      <TileLayer url={tileUrl} attribution="&copy; OpenStreetMap contributors" />
      {points.map((p, i) => (
        <CircleMarker key={i} center={[p.lat, p.lng]} radius={8} pathOptions={{ color: p.color, fillOpacity: 0.7 }}>
          <Tooltip>{p.label}</Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
