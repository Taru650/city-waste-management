import { getConfig } from '@/config/env';
import { Masters } from '@/views/pages/Masters';

export default function MastersPage() {
  return <Masters tileUrl={getConfig().mapTileUrl} />;
}
