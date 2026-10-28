import { getConfig } from '@/config/env';
import { EventZones } from '@/views/pages/EventZones';

export default function EventZonesPage() {
  return <EventZones tileUrl={getConfig().mapTileUrl} />;
}
