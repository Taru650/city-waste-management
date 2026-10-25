'use client';

import {
  AlertOutlined, BellOutlined, DashboardOutlined, DatabaseOutlined, EnvironmentOutlined, LogoutOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons';
import { Badge, Button, Dropdown, Layout, Menu, Space, Typography } from 'antd';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { call, useApi } from '@/lib/client/api';
import { ROLE_LABELS } from '@/lib/client/format';
import { isAdmin, Me, SessionProvider } from '@/lib/client/session';
import { hardNavigate } from '@/lib/client/navigate';

const { Header, Sider, Content } = Layout;

export function AppShell({ me, children }: { me: Me; children: React.ReactNode }) {
  const pathname = usePathname();
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
    { key: '/notifications', icon: <BellOutlined />, label: <Link href="/notifications">Notifications</Link> },
    { key: '/account', icon: <UserOutlined />, label: <Link href="/account">Account</Link> },
  ];
  const selected = items.map((i) => i.key).filter((k) => pathname.startsWith(k));

  const logout = async () => {
    await call('/bff/auth/logout', { method: 'POST', body: {} });
    hardNavigate('/login');
  };

  return (
    <SessionProvider value={me}>
      <Layout style={{ minHeight: '100vh' }}>
        <Sider breakpoint="lg" collapsedWidth={0} theme="light" width={220} style={{ borderRight: '1px solid #e8e8e8' }}>
          <div style={{ padding: '18px 20px', fontWeight: 700, fontSize: 18, color: '#1f7a4d' }}>Swachh Seva</div>
          <Menu mode="inline" selectedKeys={selected} items={items} style={{ borderInlineEnd: 0 }} />
        </Sider>
        <Layout>
          <Header style={{ background: '#fff', padding: '0 20px', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', borderBottom: '1px solid #e8e8e8' }}>
            <Space size="large">
              <Link href="/notifications" aria-label="Notifications">
                <Badge count={unread?.count ?? 0} size="small"><BellOutlined style={{ fontSize: 18 }} /></Badge>
              </Link>
              <Dropdown menu={{ items: [
                { key: 'account', label: <Link href="/account">Account</Link> },
                { key: 'logout', icon: <LogoutOutlined />, label: 'Sign out', onClick: logout },
              ] }}>
                <Button type="text" data-testid="user-menu">
                  <Space size={4}>
                    <UserOutlined />
                    <span>{me.name}</span>
                    <Typography.Text type="secondary">· {ROLE_LABELS[me.role]}</Typography.Text>
                  </Space>
                </Button>
              </Dropdown>
            </Space>
          </Header>
          <Content style={{ margin: 20 }}>{children}</Content>
        </Layout>
      </Layout>
    </SessionProvider>
  );
}
