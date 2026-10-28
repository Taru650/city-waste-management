import { getConfig } from '@/config/env';
import { ComplaintDetail } from '@/views/pages/ComplaintDetail';

export default async function ComplaintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ComplaintDetail id={id} tileUrl={getConfig().mapTileUrl} />;
}
