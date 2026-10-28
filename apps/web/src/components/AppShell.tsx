'use client';

import {
  AlertOutlined, BellOutlined, DashboardOutlined, DatabaseOutlined, EnvironmentOutlined, HomeOutlined, LogoutOutlined, MenuOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons';
import { App, Avatar, Badge, Breadcrumb, Button, Drawer, Dropdown, Layout, Menu } from 'antd';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useState } from 'react';
import { Brand } from '@/components/Brand';
import { call, useApi } from '@/lib/client/api';
import { ROLE_LABELS } from '@/lib/client/format';
import { isAdmin, Me, SessionProvider } from '@/lib/client/session';
import { hardNavigate } from '@/lib/client/navigate';

const { Header, Sider, Content } = Layout;

const SECTION_LABELS: Record<string, string> = {
  dashboard: 'Dashboard', complaints: 'Complaints', 'event-zones': 'Event zones', masters: 'Masters', users: 'Staff',
  notifications: 'Notifications', account: 'Account',
};

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

export function AppShell({ me, children }: { me: Me; children: React.ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { message } = App.useApp();
  const signingOut = useRef(false);
  const { data: unread } = useApi<{ count: number }>('/notifications/unread-count', { refreshInterval: 60_000 });

  const items = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: <Link href="/dashboard">Dashboard</Link> },
    { key: '/complaints', icon: <AlertOutlined />, label: <Link href="/complaints">Complaints</Link> },
    { key: '/event-zones', icon: <EnvironmentOutlined />, label: <Link href="/event-zones">Event zones</Link> },
    ...(isAdmin(me)
      ? [
          { key: '/masters', icon: <DatabaseOutlined />, label: <Link href="/masters">Masters</Link> },
          { key: '/users', icon: <TeamOutlined />, label: <Link href="/users">Staff</Link> },
        ]
      : []),
    {
      key: '/notifications', icon: <BellOutlined />,
      label: <Link href="/notifications">Notifications{unread?.count ? <Badge count={unread.count} size="small" style={{ marginLeft: 8, boxShadow: 'none' }} /> : null}</Link>,
    },
    { key: '/account', icon: <UserOutlined />, label: <Link href="/account">Account</Link> },
  ];
  const selected = items.map((i) => i.key).filter((k) => pathname.startsWith(k));
  // Choosing a page also closes the phone menu.
  const nav = <Menu mode="inline" theme="dark" selectedKeys={selected} items={items} onClick={() => setDrawerOpen(false)} style={{ borderInlineEnd: 0, paddingTop: 4 }} />;

  const segments = pathname.split('/').filter(Boolean);
  const crumbs = [
    { title: <Link href="/dashboard" aria-label="Home"><HomeOutlined /></Link> },
    ...segments.map((s, i) => ({
      title: i === segments.length - 1 ? (SECTION_LABELS[s] ?? 'Details') : <Link href={`/${segments.slice(0, i + 1).join('/')}`}>{SECTION_LABELS[s] ?? s}</Link>,
    })),
  ];

  const logout = async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    try {
      await call('/bff/auth/logout', { method: 'POST', body: {} });
    } catch {
      // Never leave an official believing they are signed out when they are not (shared office PCs).
      signingOut.current = false;
      message.error('Could not sign out. Check the connection and try again.');
      return;
    }
    hardNavigate('/login');
  };

  return (
    <SessionProvider value={me}>
      <a href="#main" className="skip-link">Skip to main content</a>
      <Layout style={{ minHeight: '100vh' }}>
        <Sider width={248} className="app-sider" style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'auto' }}>
          <div style={{ padding: '18px 18px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: 6 }}><Brand light /></div>
          <nav aria-label="Main">{nav}</nav>
        </Sider>
        <Drawer
          className="app-drawer" placement="left" open={drawerOpen} onClose={() => setDrawerOpen(false)} size={280}
          styles={{ body: { padding: 0, background: '#0b2545' }, header: { background: '#0b2545', borderBottom: '1px solid rgba(255,255,255,0.08)' } }}
          title={<Brand light />} closeIcon={<span style={{ color: '#c7d2e3' }}>✕</span>}
        >
          <nav aria-label="Main">{nav}</nav>
        </Drawer>
        <Layout>
          <Header className="app-header" style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 20 }}>
            <Button className="hide-lg" type="text" icon={<MenuOutlined style={{ fontSize: 18 }} />} aria-label="Open menu" onClick={() => setDrawerOpen(true)} />
            <div className="hide-lg" style={{ minWidth: 0 }}><Brand compact /></div>
            <Breadcrumb className="show-md" items={crumbs} />
            <div style={{ flex: 1 }} />
            <Link href="/notifications" aria-label={`Notifications${unread?.count ? `, ${unread.count} unread` : ''}`} style={{ display: 'grid', placeItems: 'center', width: 40, height: 40, borderRadius: 8 }}>
              <Badge count={unread?.count ?? 0} size="small"><BellOutlined style={{ fontSize: 19, color: '#13315c' }} /></Badge>
            </Link>
            {/* Opens on click and lives inside the sticky header: attached to <body> it scrolled away from its
                button and snapped back mid-click, so a "Sign out" click could land on nothing. */}
            <Dropdown trigger={['click']} getPopupContainer={(trigger) => trigger.parentElement ?? document.body} menu={{ items: [
              { key: 'account', label: <Link href="/account">Account</Link> },
              { key: 'logout', icon: <LogoutOutlined />, label: 'Sign out', onClick: logout },
            ] }}>
              <Button type="text" data-testid="user-menu" style={{ height: 44, paddingInline: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar size={32} style={{ background: '#0f8b8d', fontWeight: 600, fontSize: 13 }}>{initials(me.name)}</Avatar>
                <span className="show-md" style={{ textAlign: 'left', lineHeight: 1.2 }}>
                  <span style={{ display: 'block', fontWeight: 600, color: '#0f172a' }}>{me.name}</span>
                  <span style={{ display: 'block', fontSize: 12, color: '#475569' }}>{ROLE_LABELS[me.role]}</span>
                </span>
              </Button>
            </Dropdown>
          </Header>
          <Content id="main" tabIndex={-1} style={{ padding: 'var(--gutter)', outline: 'none', width: '100%', maxWidth: 1600, marginInline: 'auto' }}>{children}</Content>
        </Layout>
      </Layout>
    </SessionProvider>
  );
}
