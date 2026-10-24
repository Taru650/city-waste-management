import { AntdRegistry } from '@ant-design/nextjs-registry';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import 'leaflet/dist/leaflet.css';
import './globals.css';
import { Providers } from '@/components/Providers';

export const metadata: Metadata = {
  title: 'Swachh Seva — Grievance Portal',
  description: 'City cleanliness grievance management for ULBs and district administration',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the nonce opts every page into dynamic rendering, which the CSP nonce requires.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en">
      <body>
        <AntdRegistry>
          <Providers nonce={nonce}>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
