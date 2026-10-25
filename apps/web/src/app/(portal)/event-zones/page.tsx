import { serverConfig } from '@/lib/server/config';
import { EventZones } from './EventZones';

export default function EventZonesPage() {
  return <EventZones tileUrl={serverConfig.mapTileUrl} />;
}
