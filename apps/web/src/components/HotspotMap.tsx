'use client';

import { CircleMarker, MapContainer, TileLayer, Tooltip } from 'react-leaflet';

export interface Hotspot {
  lat: number;
  lng: number;
  total: number;
  open: number;
}

/** Complaint density: circle size = complaints, red = still open, green = all disposed. */
export default function HotspotMap({ points, tileUrl }: { points: Hotspot[]; tileUrl: string }) {
  const center: [number, number] = points.length ? [points[0].lat, points[0].lng] : [21.25, 81.63];
  return (
    <MapContainer center={center} zoom={13} style={{ height: 360 }} scrollWheelZoom={false}>
      <TileLayer url={tileUrl} attribution="&copy; OpenStreetMap contributors" />
      {points.map((p) => (
        <CircleMarker key={`${p.lat},${p.lng}`} center={[p.lat, p.lng]} radius={Math.min(6 + Math.sqrt(p.total) * 3, 30)}
          pathOptions={{ color: p.open ? '#cf1322' : '#389e0d', fillOpacity: 0.45, weight: 1 }}>
          <Tooltip>{p.total} complaints · {p.open} open</Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
