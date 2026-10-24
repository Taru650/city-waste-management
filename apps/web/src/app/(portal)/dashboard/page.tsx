import { serverConfig } from '@/lib/server/config';
import { Dashboard } from './Dashboard';

export default function DashboardPage() {
  return <Dashboard tileUrl={serverConfig.mapTileUrl} />;
}
