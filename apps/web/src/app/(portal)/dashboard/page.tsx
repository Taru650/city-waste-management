import { serverConfig } from '@/lib/server/config';
import { Dashboard } from './Dashboard';

/** `?eventZoneId=` opens the dashboard for one event zone (linked from the Event zones page). */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const zone = (await searchParams).eventZoneId;
  const eventZoneId = typeof zone === 'string' && /^[0-9a-f-]{36}$/i.test(zone) ? zone : undefined;
  return <Dashboard tileUrl={serverConfig.mapTileUrl} initialEventZoneId={eventZoneId} />;
}
