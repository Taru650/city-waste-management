'use client';

import { Button, Card, Checkbox, Select, Space, Table, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Filters, FilterBar } from '@/components/FilterBar';
import { qs, useApi } from '@/lib/client/api';
import { fmtDateTime, STATUS_COLORS, STATUS_LABELS } from '@/lib/client/format';
import { useMe } from '@/lib/client/session';
import { colors } from '@/theme';
import { PageHeader } from '@/components/PageHeader';

export interface ComplaintItem {
  id: string;
  complaintNo: string;
  status: string;
  description: string;
  landmark: string | null;
  ward: { id: string; number: number };
  ulb: { id: string; name: string };
  type: { nameEn: string; nameHi: string };
  supervisor: { id: string; name: string } | null;
  worker: { id: string; name: string } | null;
  slaDueAt: string;
  slaBreached: boolean;
  escalated: boolean;
  wardMismatch: boolean;
  reopenCount: number;
  createdAt: string;
}

function ComplaintsInbox() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const state = Object.fromEntries(params.entries()) as Record<string, string>;
  const page = Number(state.page ?? 1);
  const setState = (patch: Record<string, unknown>) => {
    const next = { ...state, ...patch };
    if (!('page' in patch)) next.page = '1';
    router.replace(`/complaints${qs(next)}`);
  };
  const { data, isLoading } = useApi<{ total: number; items: ComplaintItem[] }>(`/complaints${qs({ ...state, pageSize: 25 })}`);

  return (
    <>
      <PageHeader eyebrow="Grievances" title="Complaints" subtitle={data ? `${data.total.toLocaleString('en-IN')} matching complaint${data.total === 1 ? '' : 's'}` : '\u00a0'} />
      <FilterBar me={me} dates={false} value={state as Filters} onChange={(f) => setState({ ...f })} />
      <Space wrap style={{ marginBottom: 16 }}>
        <Select allowClear placeholder="Any status" style={{ width: 180 }} value={state.status} aria-label="Status filter"
          options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          onChange={(v) => setState({ status: v })} />
        <Checkbox checked={state.overdue === 'true'} onChange={(e) => setState({ overdue: e.target.checked ? 'true' : undefined })}>Past SLA</Checkbox>
        <Checkbox checked={state.escalated === 'true'} onChange={(e) => setState({ escalated: e.target.checked ? 'true' : undefined })}>Escalated</Checkbox>
        <Button onClick={() => router.replace('/complaints')}>Clear</Button>
      </Space>
      <Card size="small">
        <Table<ComplaintItem>
          rowKey="id" size="middle" loading={isLoading} dataSource={data?.items} data-testid="complaints-table" scroll={{ x: 1000 }}
          pagination={{ current: page, pageSize: 25, total: data?.total, showSizeChanger: false, showTotal: (t) => `${t} complaints`, onChange: (p) => setState({ page: String(p) }) }}
          onRow={(r) => ({ onClick: () => router.push(`/complaints/${r.id}`), style: { cursor: 'pointer' } })}
          columns={[
            { title: 'Complaint no.', dataIndex: 'complaintNo', render: (v, r) => <Link className="nowrap" href={`/complaints/${r.id}`} onClick={(e) => e.stopPropagation()}>{v}</Link> },
            { title: 'Filed', dataIndex: 'createdAt', render: (v) => <span className="nowrap">{fmtDateTime(v)}</span> },
            { title: 'Ward', render: (_, r) => (me.ulbId ? `Ward ${r.ward.number}` : `${r.ulb.name} · ${r.ward.number}`) },
            { title: 'Type', render: (_, r) => r.type.nameEn },
            { title: 'Status', dataIndex: 'status', render: (v: string, r) => (
              <Space size={4} wrap>
                <Tag color={STATUS_COLORS[v]}>{STATUS_LABELS[v]}</Tag>
                {r.escalated && <Tag color="red">Escalated</Tag>}
                {r.wardMismatch && <Tag color="gold">Ward?</Tag>}
              </Space>
            ) },
            { title: 'SLA due', dataIndex: 'slaDueAt', render: (v, r) => (r.slaBreached
              ? <span className="nowrap" style={{ color: colors.danger, fontWeight: 600 }}>{fmtDateTime(v)} · overdue</span>
              : <span className="nowrap">{fmtDateTime(v)}</span>) },
            { title: 'Supervisor', render: (_, r) => r.supervisor?.name ?? '—' },
            { title: 'Worker', render: (_, r) => r.worker?.name ?? '—' },
          ]}
        />
      </Card>
    </>
  );
}

export default function ComplaintsPage() {
  return <Suspense><ComplaintsInbox /></Suspense>;
}
