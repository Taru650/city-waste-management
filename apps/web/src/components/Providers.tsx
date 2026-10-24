'use client';

import { App, ConfigProvider } from 'antd';
import enGB from 'antd/locale/en_GB';

/** Theme: municipal green, readable density for long working sessions. */
export function Providers({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <ConfigProvider
      locale={enGB}
      csp={nonce ? { nonce } : undefined}
      theme={{ token: { colorPrimary: '#1f7a4d', borderRadius: 6, fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", sans-serif' } }}
    >
      <App>{children}</App>
    </ConfigProvider>
  );
}
