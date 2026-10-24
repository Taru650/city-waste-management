import { serverConfig } from '@/lib/server/config';
import { Masters } from './Masters';

export default function MastersPage() {
  return <Masters tileUrl={serverConfig.mapTileUrl} />;
}
