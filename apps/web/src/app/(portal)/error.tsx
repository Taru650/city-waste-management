'use client';

import { Button, Result } from 'antd';
import Link from 'next/link';

/** A page that fails while rendering: say so plainly and offer a retry, never a blank screen. */
export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Result
      status="error"
      title="This page could not be displayed"
      subTitle={<>Something went wrong while loading it. Try again; if it keeps happening, report it with this reference: <code>{error.digest ?? 'client error'}</code></>}
      extra={[
        <Button type="primary" key="retry" onClick={reset}>Try again</Button>,
        <Link key="home" href="/dashboard"><Button>Go to dashboard</Button></Link>,
      ]}
    />
  );
}
