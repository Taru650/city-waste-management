import { Button, Result } from 'antd';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Result status="404" title="Page not found" subTitle="The address may be mistyped, or the page has moved."
        extra={<Link href="/dashboard"><Button type="primary">Go to dashboard</Button></Link>} />
    </div>
  );
}
