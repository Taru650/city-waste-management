'use client';

import { App, ConfigProvider, Empty } from 'antd';
import enGB from 'antd/locale/en_GB';
import { antdTheme } from '@/theme';

/** Theme: navy / royal blue / teal official palette (src/theme.ts), readable density for long sessions. */
export function Providers({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <ConfigProvider locale={enGB} csp={nonce ? { nonce } : undefined} theme={antdTheme}
      renderEmpty={() => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing to show for the current filters" />}>
      <App>{children}</App>
    </ConfigProvider>
  );
}
