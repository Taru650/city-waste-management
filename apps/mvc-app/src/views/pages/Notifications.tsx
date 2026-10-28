'use client';

import { Badge, Button, Card, List, Space, Typography } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import { api, qs, useApi } from '@/views/lib/api';
import { fmtDateTime } from '@/views/lib/format';
import { PageHeader } from '@/views/components/PageHeader';

interface Note { id: string; type: string; complaintId: string | null; title: string; body: string; readAt: string | null; createdAt: string }

export function Notifications() {
  const [page, setPage] = useState(1);
  const { data, mutate } = useApi<{ total: number; items: Note[] }>(`/notifications${qs({ page, pageSize: 20 })}`);
  const markRead = async (n: Note) => {
    if (!n.readAt) {
      await api(`/notifications/${n.id}/read`, { method: 'POST', body: {} });
      await mutate();
    }
  };
  return (
    <>
      <PageHeader eyebrow="Inbox" title="Notifications" subtitle="Assignments, SLA alerts and escalations for you"
        actions={<Button onClick={async () => { await api('/notifications/read-all', { method: 'POST', body: {} }); await mutate(); }}>Mark all read</Button>} />
      <Card size="small">
        <List<Note> dataSource={data?.items} data-testid="notifications"
          pagination={{ current: page, pageSize: 20, total: data?.total, onChange: setPage, hideOnSinglePage: true }}
          renderItem={(n) => (
            <List.Item onClick={() => markRead(n)} style={{ cursor: 'pointer' }}
              actions={n.complaintId ? [<Link key="open" href={`/complaints/${n.complaintId}`}>Open</Link>] : []}>
              <List.Item.Meta
                avatar={<Badge dot={!n.readAt} />}
                title={<span style={{ fontWeight: n.readAt ? 400 : 600 }}>{n.title}</span>}
                description={<>{n.body} <Typography.Text type="secondary">· {fmtDateTime(n.createdAt)}</Typography.Text></>}
              />
            </List.Item>
          )} />
      </Card>
    </>
  );
}
