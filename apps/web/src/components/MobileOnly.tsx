'use client';

import { Button, Result } from 'antd';
import { call } from '@/lib/client/api';
import { hardNavigate } from '@/lib/client/navigate';

export function MobileOnly({ role }: { role: string }) {
  return (
    <Result
      status="info"
      title="Please use the mobile app"
      subTitle={role === 'WORKER' ? 'Field tasks are done in the Swachh Seva Staff app.' : 'Complaints are filed in the Swachh Seva app.'}
      extra={<Button onClick={async () => { await call('/bff/auth/logout', { method: 'POST', body: {} }); hardNavigate('/login'); }}>Sign out</Button>}
    />
  );
}
