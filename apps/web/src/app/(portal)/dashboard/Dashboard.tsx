'use client';

import {
  AimOutlined, CheckCircleOutlined, ClockCircleOutlined, DownloadOutlined, FieldTimeOutlined, InboxOutlined, PrinterOutlined, RiseOutlined,
  RollbackOutlined, SafetyCertificateOutlined, SmileOutlined, StarOutlined, ThunderboltOutlined, WarningOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Col, Dropdown, Grid, Row, Segmented, Statistic, Table, Typography } from 'antd';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Chart } from '@/components/Chart';
import { Filters, FilterBar } from '@/components/FilterBar';
import type { Hotspot } from '@/components/HotspotMap';
import { PageHeader, PrintHeader } from '@/components/PageHeader';
import { qs, useApi } from '@/lib/client/api';
import { fmtNum, ROLE_LABELS } from '@/lib/client/format';
import { useMe } from '@/lib/client/session';
import { ageingColors, chartPalette, colors } from '@/theme';

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

type Tone = 'royal' | 'success' | 'warning' | 'danger' | 'teal' | 'neutral';
const TONES: Record<Tone, { fg: string; bg: string }> = {
  royal: { fg: colors.royal, bg: colors.royalSoft },
  success: { fg: colors.success, bg: colors.successSoft },
  warning: { fg: colors.warning, bg: colors.warningSoft },
  danger: { fg: colors.danger, bg: colors.dangerSoft },
  teal: { fg: colors.teal, bg: colors.tealSoft },
  neutral: { fg: colors.textMuted, bg: '#eef2f7' },
};

function Kpi({ title, value, suffix, testId, tone = 'neutral', icon, note, primary }: {
  title: string; value: number | string | null | undefined; suffix?: string; testId: string; tone?: Tone; icon: React.ReactNode; note?: React.ReactNode; primary?: boolean;
}) {
  const t = TONES[tone];
  return (
    <Card size="small" className={`kpi ${primary ? 'kpi--primary' : 'kpi--secondary'}`} style={primary ? ({ '--kpi-accent': t.fg } as React.CSSProperties) : undefined}>
      <span className="kpi__icon" style={{ color: t.fg, background: t.bg }} aria-hidden="true">{icon}</span>
      <div className="kpi__body">
        <Statistic title={title} value={value ?? '—'} suffix={value === null || value === undefined ? undefined : suffix}
          styles={{ content: { color: primary && tone !== 'neutral' ? t.fg : undefined } }} data-testid={testId} />
        {note && <div className="kpi__note">{note}</div>}
      </div>
    </Card>
  );
}

export function Dashboard({ tileUrl, initialEventZoneId }: { tileUrl: string; initialEventZoneId?: string }) {
  const me = useMe();
  const screens = Grid.useBreakpoint();
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

  const range = s ? `${s.range.from} to ${s.range.to} (IST)` : undefined;
  const open = s?.counts.pending ?? 0;

  return (
    <>
      <PrintHeader title="Grievance dashboard report" scope={[ROLE_LABELS[me.role], range].filter(Boolean).join(' · ')} />
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        subtitle={range ?? '\u00a0'}
        actions={<>
          <Dropdown menu={exportMenu('complaints')}><Button icon={<DownloadOutlined />}>Export complaints</Button></Dropdown>
          <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print / PDF</Button>
        </>}
      />
      <FilterBar me={me} value={filters} onChange={setFilters} effectiveRange={s?.range} />
      {error && <Alert type="error" showIcon title={error.message} style={{ marginBottom: 16 }} />}

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}><Kpi primary title="Received" value={s?.counts.received} testId="kpi-received" tone="royal" icon={<InboxOutlined />}
          note={s ? `in the selected period` : undefined} /></Col>
        <Col xs={12} lg={6}><Kpi primary title="Resolved" value={s?.counts.resolved} testId="kpi-resolved" tone="success" icon={<CheckCircleOutlined />}
          note={s?.disposal.disposalRatePct !== null && s?.disposal.disposalRatePct !== undefined ? `${s.disposal.disposalRatePct}% resolution rate` : undefined} /></Col>
        <Col xs={12} lg={6}><Kpi primary title="Pending" value={s?.counts.pending} testId="kpi-pending" tone="warning" icon={<ClockCircleOutlined />}
          note={s ? 'open now, awaiting action' : undefined} /></Col>
        <Col xs={12} lg={6}><Kpi primary title="Past SLA (open)" value={s?.counts.overdue} testId="kpi-overdue" tone={s?.counts.overdue ? 'danger' : 'success'} icon={<WarningOutlined />}
          note={s ? (s.counts.overdue ? `of ${open} open complaints` : 'none overdue') : undefined} /></Col>
      </Row>

      <div className="section-label">Timeliness</div>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}><Kpi title="SLA met" value={s?.disposal.slaCompliancePct} suffix="%" testId="kpi-sla" tone="teal" icon={<SafetyCertificateOutlined />} /></Col>
        <Col xs={12} md={6}><Kpi title="Avg disposal" value={s?.disposal.avgHours} suffix="h" testId="kpi-disposal" tone="royal" icon={<FieldTimeOutlined />} /></Col>
        <Col xs={12} md={6}>
          <Kpi title="Median / P90 disposal" testId="kpi-median" suffix="h" tone="royal" icon={<RiseOutlined />}
            value={s && s.disposal.medianHours !== null ? `${s.disposal.medianHours} / ${s.disposal.p90Hours}` : null} />
        </Col>
        <Col xs={12} md={6}><Kpi title="Escalated" value={s?.counts.escalated} testId="kpi-escalated" tone={s?.counts.escalated ? 'danger' : 'neutral'} icon={<ThunderboltOutlined />} /></Col>
      </Row>

      <div className="section-label">Citizen satisfaction &amp; proof quality</div>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}><Kpi title="Avg citizen rating" value={s?.quality.avgRating} suffix="/ 5" testId="kpi-rating" tone="warning" icon={<StarOutlined />}
          note={s ? `${s.quality.feedbacks} rating${s.quality.feedbacks === 1 ? '' : 's'}` : undefined} /></Col>
        <Col xs={12} md={6}><Kpi title="Satisfied (4–5 ★)" value={s?.quality.satisfiedPct} suffix="%" testId="kpi-satisfied" tone="success" icon={<SmileOutlined />} /></Col>
        <Col xs={12} md={6}><Kpi title="Reopen rate" value={s?.quality.reopenRatePct} suffix="%" testId="kpi-reopen" tone={s?.quality.reopenRatePct ? 'warning' : 'neutral'} icon={<RollbackOutlined />} /></Col>
        <Col xs={12} md={6}><Kpi title="Proofs > 100 m away" value={s?.quality.proofsOutsideGeofencePct} suffix="%" testId="kpi-geofence" tone={s?.quality.proofsOutsideGeofencePct ? 'danger' : 'neutral'} icon={<AimOutlined />} /></Col>
      </Row>

      <div className="section-label">Trends</div>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card title="Date-wise received, resolved and pending" size="small" style={{ height: '100%' }}
            extra={<Dropdown menu={exportMenu('trend')}><Button size="small" icon={<DownloadOutlined />} className="no-print" aria-label="Export trend" /></Dropdown>}>
            <Chart testId="chart-trend" option={{
              color: [colors.royal, colors.success, colors.warningFill],
              tooltip: { trigger: 'axis' }, legend: { bottom: 0, icon: 'roundRect' }, grid: { left: 8, right: 16, top: 16, bottom: 40, containLabel: true },
              xAxis: { type: 'category', data: trend?.rows.map((r) => r.date.slice(5)) ?? [], axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.textMuted, hideOverlap: true } },
              yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#eef2f7' } }, axisLabel: { color: colors.textMuted } },
              series: [
                { name: 'Received', type: 'bar', data: trend?.rows.map((r) => r.received) ?? [], barMaxWidth: 14, itemStyle: { borderRadius: [3, 3, 0, 0] } },
                { name: 'Resolved', type: 'bar', data: trend?.rows.map((r) => r.resolved) ?? [], barMaxWidth: 14, itemStyle: { borderRadius: [3, 3, 0, 0] } },
                { name: 'Pending at day end', type: 'line', data: trend?.rows.map((r) => r.pending) ?? [], smooth: true, symbolSize: 5, lineStyle: { width: 2.5 } },
              ],
            }} />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card title="Complaint types" size="small" style={{ height: '100%' }}>
            <Chart testId="chart-types" option={{
              color: chartPalette,
              tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
              legend: { bottom: 0, type: 'scroll', icon: 'circle' },
              series: [{ type: 'pie', radius: ['48%', '72%'], center: ['50%', '44%'], avoidLabelOverlap: true, label: { show: false },
                itemStyle: { borderColor: '#fff', borderWidth: 2 },
                data: s?.byType.map((t) => ({ name: t.nameEn, value: t.count })) ?? [] }],
              graphic: s ? [{ type: 'text', left: 'center', top: '38%', style: { text: String(s.counts.received), fontSize: 26, fontWeight: 700, fill: colors.navy } },
                { type: 'text', left: 'center', top: '50%', style: { text: 'complaints', fontSize: 12, fill: colors.textMuted } }] : [],
            }} />
          </Card>
        </Col>
      </Row>

      <Card title="Pendency ageing (open complaints, as of now)" size="small" style={{ marginTop: 16 }}
        extra={<Dropdown menu={exportMenu('ageing')}><Button size="small" icon={<DownloadOutlined />} className="no-print" aria-label="Export ageing" /></Dropdown>}>
        <Chart testId="chart-ageing" height={Math.max(220, (ageing?.rows.length ?? 0) * 34 + 90)} option={{
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } }, legend: { bottom: 0, icon: 'roundRect' },
          grid: { left: 8, right: 16, top: 8, bottom: 44, containLabel: true },
          xAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#eef2f7' } }, axisLabel: { color: colors.textMuted } },
          yAxis: { type: 'category', data: ageing?.rows.map((r) => String(r.label)) ?? [], axisLabel: { color: colors.text, width: screens.md ? 240 : 110, overflow: 'truncate' } },
          series: ([['d0_1', '< 1 day'], ['d1_3', '1–3 days'], ['d3_7', '3–7 days'], ['d7_15', '7–15 days'], ['d15_plus', '> 15 days']] as const)
            .map(([k, name], i) => ({ name, type: 'bar' as const, stack: 'age', barMaxWidth: 22, itemStyle: { color: ageingColors[i] }, data: ageing?.rows.map((r) => Number(r[k])) ?? [] })),
        }} />
      </Card>

      <Card size="small" style={{ marginTop: 16 }} title="Performance"
        extra={<Dropdown menu={exportMenu('breakdown')}><Button size="small" icon={<DownloadOutlined />} className="no-print">Export</Button></Dropdown>}>
        <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <Typography.Text type="secondary">Group by</Typography.Text>
          <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
            <Segmented size="small" value={dim} onChange={(v) => setDim(v as Dim)} options={dims} aria-label="Group performance by" />
          </div>
        </div>
        <Table<BreakdownRow> size="small" rowKey={(r) => r.key ?? 'none'} dataSource={breakdown?.rows} loading={!breakdown}
          pagination={{ pageSize: 15, hideOnSinglePage: true, showTotal: (t) => `${t} rows` }}
          data-testid="breakdown-table" scroll={{ x: 900 }}
          locale={{ emptyText: 'No complaints in the selected period' }}
          summary={(rows) => rows.length > 1 ? (
            <Table.Summary.Row style={{ fontWeight: 600 }}>
              <Table.Summary.Cell index={0}>Total</Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">{rows.reduce((a, r) => a + r.received, 0)}</Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">{rows.reduce((a, r) => a + r.resolved, 0)}</Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right">{rows.reduce((a, r) => a + r.pending, 0)}</Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">{rows.reduce((a, r) => a + r.overdue, 0)}</Table.Summary.Cell>
              <Table.Summary.Cell index={5} colSpan={4} />
            </Table.Summary.Row>
          ) : undefined}
          columns={[
            { title: 'Name', dataIndex: 'label', fixed: 'left', width: 200 },
            { title: 'Received', dataIndex: 'received', align: 'right', sorter: (a, b) => a.received - b.received },
            { title: 'Resolved', dataIndex: 'resolved', align: 'right', sorter: (a, b) => a.resolved - b.resolved },
            { title: 'Pending', dataIndex: 'pending', align: 'right', sorter: (a, b) => a.pending - b.pending },
            { title: 'Past SLA', dataIndex: 'overdue', align: 'right', sorter: (a, b) => a.overdue - b.overdue, render: (v: number) => <span style={{ color: v ? colors.danger : undefined, fontWeight: v ? 600 : undefined }}>{v}</span> },
            { title: 'Avg disposal (h)', dataIndex: 'avgDisposalHours', align: 'right', render: (v) => fmtNum(v) },
            { title: 'SLA met', dataIndex: 'slaCompliancePct', align: 'right', render: (v) => fmtNum(v, '%') },
            { title: 'Rating', dataIndex: 'avgRating', align: 'right', render: (v) => fmtNum(v) },
            { title: 'Reopen', dataIndex: 'reopenRatePct', align: 'right', render: (v) => fmtNum(v, '%') },
          ]} />
      </Card>

      <Card title="Hotspots" size="small" style={{ marginTop: 16 }} className="no-print"
        extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>Complaint clusters in the selected period</Typography.Text>}>
        <HotspotMap points={hotspots?.points ?? []} tileUrl={tileUrl} />
      </Card>
    </>
  );
}
