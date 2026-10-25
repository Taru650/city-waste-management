'use client';

import { DownloadOutlined, PrinterOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Dropdown, Row, Segmented, Space, Statistic, Table, Typography } from 'antd';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Chart } from '@/components/Chart';
import { Filters, FilterBar } from '@/components/FilterBar';
import type { Hotspot } from '@/components/HotspotMap';
import { qs, useApi } from '@/lib/client/api';
import { fmtNum } from '@/lib/client/format';
import { useMe } from '@/lib/client/session';

const HotspotMap = dynamic(() => import('@/components/HotspotMap'), { ssr: false, loading: () => <div style={{ height: 360 }} /> });

interface Summary {
  range: { from: string; to: string; days: number };
  counts: Record<'received' | 'resolved' | 'pending' | 'rejected' | 'duplicate' | 'overdue' | 'escalated', number>;
  disposal: { disposalRatePct: number | null; avgHours: number | null; medianHours: number | null; p90Hours: number | null; avgAssignmentHours: number | null; slaCompliancePct: number | null };
  quality: { feedbacks: number; avgRating: number | null; satisfiedPct: number | null; reopenRatePct: number | null; proofsOutsideGeofencePct: number | null; wardMismatchPct: number | null };
  byType: { code: string; nameEn: string; count: number }[];
}
interface BreakdownRow { key: string | null; label: string; received: number; resolved: number; pending: number; overdue: number; rejectedOrDuplicate: number; avgDisposalHours: number | null; slaCompliancePct: number | null; avgRating: number | null; reopenRatePct: number | null }
type Dim = 'district' | 'ulb' | 'ward' | 'type' | 'supervisor' | 'worker';

function Kpi({ title, value, suffix, testId, tone }: { title: string; value: number | string | null | undefined; suffix?: string; testId: string; tone?: 'bad' | 'good' }) {
  return (
    <Card size="small" className="kpi">
      <Statistic title={title} value={value ?? '—'} suffix={value === null || value === undefined ? undefined : suffix}
        styles={{ content: { color: tone === 'bad' ? '#cf1322' : tone === 'good' ? '#1f7a4d' : undefined } }} data-testid={testId} />
    </Card>
  );
}

export function Dashboard({ tileUrl, initialEventZoneId }: { tileUrl: string; initialEventZoneId?: string }) {
  const me = useMe();
  const [filters, setFilters] = useState<Filters>(initialEventZoneId ? { eventZoneId: initialEventZoneId } : {});
  const defaultDim: Dim = me.role === 'WEB_ADMIN' ? 'district' : me.role === 'DISTRICT_ADMIN' ? 'ulb' : me.role === 'SUB_ADMIN' ? 'ward' : 'worker';
  const [dim, setDim] = useState<Dim>(defaultDim);
  const q = qs(filters as Record<string, unknown>);
  const { data: s, error } = useApi<Summary>(`/reports/summary${q}`);
  const { data: trend } = useApi<{ rows: { date: string; received: number; resolved: number; pending: number }[] }>(`/reports/trend${q}`);
  const ageingDim = dim === 'worker' ? 'supervisor' : dim;
  const { data: ageing } = useApi<{ rows: Record<string, number | string>[] }>(`/reports/ageing${qs({ ...filters, groupBy: ageingDim })}`);
  const { data: breakdown } = useApi<{ rows: BreakdownRow[] }>(`/reports/breakdown${qs({ ...filters, by: dim })}`);
  const { data: hotspots } = useApi<{ points: Hotspot[] }>(`/reports/hotspots${q}`);

  const exportUrl = (report: string, format: 'xlsx' | 'csv') =>
    `/bff/api/reports/export${qs({ ...filters, report, format, by: dim, groupBy: ageingDim })}`;
  const exportMenu = (report: string) => ({
    items: [
      { key: 'xlsx', label: <a href={exportUrl(report, 'xlsx')} download>Excel (.xlsx)</a> },
      { key: 'csv', label: <a href={exportUrl(report, 'csv')} download>CSV</a> },
    ],
  });
  const dims: { value: Dim; label: string }[] = [
    ...(me.role === 'WEB_ADMIN' ? [{ value: 'district' as Dim, label: 'District' }] : []),
    ...(['WEB_ADMIN', 'DISTRICT_ADMIN'].includes(me.role) ? [{ value: 'ulb' as Dim, label: 'ULB' }] : []),
    { value: 'ward', label: 'Ward' }, { value: 'type', label: 'Type' }, { value: 'supervisor', label: 'Supervisor' }, { value: 'worker', label: 'Worker' },
  ];

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>Dashboard</Typography.Title>
          <Typography.Text type="secondary">{s ? `${s.range.from} to ${s.range.to} (IST)` : ' '}</Typography.Text>
        </div>
        <Space className="no-print">
          <Dropdown menu={exportMenu('complaints')}><Button icon={<DownloadOutlined />}>Export complaints</Button></Dropdown>
          <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print / PDF</Button>
        </Space>
      </Space>
      <div style={{ marginTop: 16 }}><FilterBar me={me} value={filters} onChange={setFilters} effectiveRange={s?.range} /></div>
      {error && <Alert type="error" showIcon title={error.message} style={{ marginBottom: 16 }} />}

      <Row gutter={[12, 12]}>
        <Col xs={12} md={8} xl={4}><Kpi title="Received" value={s?.counts.received} testId="kpi-received" /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="Resolved" value={s?.counts.resolved} testId="kpi-resolved" tone="good" /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="Pending" value={s?.counts.pending} testId="kpi-pending" /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="Past SLA (open)" value={s?.counts.overdue} testId="kpi-overdue" tone={s?.counts.overdue ? 'bad' : undefined} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="SLA met" value={s?.disposal.slaCompliancePct} suffix="%" testId="kpi-sla" /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="Avg disposal" value={s?.disposal.avgHours} suffix="h" testId="kpi-disposal" /></Col>
        <Col xs={12} md={8} xl={4}>
          <Kpi title="Median / P90 disposal" testId="kpi-median" suffix="h"
            value={s && s.disposal.medianHours !== null ? `${s.disposal.medianHours} / ${s.disposal.p90Hours}` : null} />
        </Col>
        <Col xs={12} md={8} xl={4}><Kpi title="Escalated" value={s?.counts.escalated} testId="kpi-escalated" tone={s?.counts.escalated ? 'bad' : undefined} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="Avg citizen rating" value={s?.quality.avgRating} suffix="/ 5" testId="kpi-rating" /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="Satisfied (4–5 ★)" value={s?.quality.satisfiedPct} suffix="%" testId="kpi-satisfied" /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="Reopen rate" value={s?.quality.reopenRatePct} suffix="%" testId="kpi-reopen" /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="Proofs > 100 m away" value={s?.quality.proofsOutsideGeofencePct} suffix="%" testId="kpi-geofence" /></Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={16}>
          <Card title="Date-wise received, resolved and pending" size="small"
            extra={<Dropdown menu={exportMenu('trend')}><Button size="small" icon={<DownloadOutlined />} className="no-print" /></Dropdown>}>
            <Chart testId="chart-trend" option={{
              tooltip: { trigger: 'axis' }, legend: { bottom: 0 }, grid: { left: 40, right: 16, top: 16, bottom: 48 },
              xAxis: { type: 'category', data: trend?.rows.map((r) => r.date.slice(5)) ?? [] },
              yAxis: { type: 'value', minInterval: 1 },
              series: [
                { name: 'Received', type: 'bar', data: trend?.rows.map((r) => r.received) ?? [], itemStyle: { color: '#91caff' } },
                { name: 'Resolved', type: 'bar', data: trend?.rows.map((r) => r.resolved) ?? [], itemStyle: { color: '#1f7a4d' } },
                { name: 'Pending at day end', type: 'line', data: trend?.rows.map((r) => r.pending) ?? [], itemStyle: { color: '#d4380d' }, smooth: true },
              ],
            }} />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card title="Complaint types" size="small">
            <Chart testId="chart-types" option={{
              tooltip: { trigger: 'item' },
              series: [{ type: 'pie', radius: ['40%', '70%'], label: { formatter: '{b}: {c}' }, data: s?.byType.map((t) => ({ name: t.nameEn, value: t.count })) ?? [] }],
            }} />
          </Card>
        </Col>
      </Row>

      <Card title="Pendency ageing (open complaints, as of now)" size="small" style={{ marginTop: 12 }}
        extra={<Dropdown menu={exportMenu('ageing')}><Button size="small" icon={<DownloadOutlined />} className="no-print" /></Dropdown>}>
        <Chart testId="chart-ageing" height={Math.max(220, (ageing?.rows.length ?? 0) * 32 + 80)} option={{
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } }, legend: { bottom: 0 },
          grid: { left: 140, right: 16, top: 8, bottom: 48 },
          xAxis: { type: 'value', minInterval: 1 },
          yAxis: { type: 'category', data: ageing?.rows.map((r) => String(r.label)) ?? [] },
          series: ([['d0_1', '< 1 day', '#b7eb8f'], ['d1_3', '1–3 days', '#ffe58f'], ['d3_7', '3–7 days', '#ffc069'], ['d7_15', '7–15 days', '#ff9c6e'], ['d15_plus', '> 15 days', '#cf1322']] as const)
            .map(([k, name, color]) => ({ name, type: 'bar' as const, stack: 'age', itemStyle: { color }, data: ageing?.rows.map((r) => Number(r[k])) ?? [] })),
        }} />
      </Card>

      <Card size="small" style={{ marginTop: 12 }}
        title={<Space>Performance by <Segmented size="small" value={dim} onChange={(v) => setDim(v as Dim)} options={dims} className="no-print" /></Space>}
        extra={<Dropdown menu={exportMenu('breakdown')}><Button size="small" icon={<DownloadOutlined />} className="no-print">Export</Button></Dropdown>}>
        <Table<BreakdownRow> size="small" rowKey={(r) => r.key ?? 'none'} dataSource={breakdown?.rows} pagination={{ pageSize: 15, hideOnSinglePage: true }}
          data-testid="breakdown-table" scroll={{ x: 900 }}
          columns={[
            { title: 'Name', dataIndex: 'label', fixed: 'left' },
            { title: 'Received', dataIndex: 'received', align: 'right', sorter: (a, b) => a.received - b.received },
            { title: 'Resolved', dataIndex: 'resolved', align: 'right', sorter: (a, b) => a.resolved - b.resolved },
            { title: 'Pending', dataIndex: 'pending', align: 'right', sorter: (a, b) => a.pending - b.pending },
            { title: 'Past SLA', dataIndex: 'overdue', align: 'right', sorter: (a, b) => a.overdue - b.overdue, render: (v: number) => <span style={{ color: v ? '#cf1322' : undefined }}>{v}</span> },
            { title: 'Avg disposal (h)', dataIndex: 'avgDisposalHours', align: 'right', render: (v) => fmtNum(v) },
            { title: 'SLA met', dataIndex: 'slaCompliancePct', align: 'right', render: (v) => fmtNum(v, '%') },
            { title: 'Rating', dataIndex: 'avgRating', align: 'right', render: (v) => fmtNum(v) },
            { title: 'Reopen', dataIndex: 'reopenRatePct', align: 'right', render: (v) => fmtNum(v, '%') },
          ]} />
      </Card>

      <Card title="Hotspots" size="small" style={{ marginTop: 12 }} className="no-print">
        <HotspotMap points={hotspots?.points ?? []} tileUrl={tileUrl} />
      </Card>
    </>
  );
}
