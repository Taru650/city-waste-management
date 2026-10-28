import { ComplaintDetail } from './ComplaintDetail';
import { serverConfig } from '@/lib/server/config';

export default async function ComplaintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ComplaintDetail id={id} tileUrl={serverConfig.mapTileUrl} />;
}
