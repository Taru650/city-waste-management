'use client';

import { UploadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import dayjs, { Dayjs } from 'dayjs';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import { api, qs, useApi } from '@/lib/client/api';
import { extractPolygon, PolygonGeometry } from '@/lib/client/geojson';
import { isAdmin, useMe } from '@/lib/client/session';

const BoundaryMap = dynamic(() => import('@/components/BoundaryMap'), { ssr: false, loading: () => <div style={{ height: 380 }} /> });

interface Zone {
  id: string; ulbId: string; ulbName: string; name: string; boundary: PolygonGeometry; startsAt: string; endsAt: string;
  supervisorId: string | null; supervisorName: string | null; slaHours: number | null; active: boolean; handedOverAt: string | null; current: boolean; areaM2: number;
}
interface ZoneDetail extends Zone { stats: { total: number; open: number; overdue: number; avgDisposalHours: number | null } }
type When = 'current' | 'upcoming' | 'past' | 'all';

function status(z: Zone) {
  if (!z.active) return <Tag>Cancelled</Tag>;
  if (z.current) return <Tag color="green">Running</Tag>;
  if (dayjs(z.startsAt).isAfter(dayjs())) return <Tag color="blue">Upcoming</Tag>;
  return <Tag color="default">Ended{z.handedOverAt ? ' · handed over' : ''}</Tag>;
}
const fmt = (d: string) => dayjs(d).format('DD MMM YYYY, HH:mm');

/** Festivals, melas, monsoon hotspots: complaints inside a running zone go to its supervisor with a tighter deadline. */
export function EventZones({ tileUrl }: { tileUrl: string }) {
  const me = useMe();
  const { message } = App.useApp();
  const manage = isAdmin(me);
  const [when, setWhen] = useState<When>('all');
  const [ulbId, setUlbId] = useState<string | undefined>(me.ulbId ?? undefined);
  const { data: zones, mutate, isLoading } = useApi<Zone[]>(`/event-zones${qs({ when, ulbId: me.ulbId ? undefined : ulbId })}`);
  const { data: ulbs } = useApi<{ id: string; name: string }[]>(me.role === 'DISTRICT_ADMIN' ? `/masters/districts/${me.districtId}/ulbs` : null);
  const [editing, setEditing] = useState<Zone | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const cancel = async (z: Zone) => {
    try {
      await api(`/event-zones/${z.id}`, { method: 'PATCH', body: { active: false } });
      message.success('Zone cancelled; open complaints go back to the area supervisors');
      await mutate();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <>
      <Typography.Title level={3} style={{ marginTop: 0 }}>Event zones</Typography.Title>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented<When> value={when} onChange={setWhen} aria-label="Zone period"
          options={[{ value: 'all', label: 'All' }, { value: 'current', label: 'Running' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Ended' }]} />
        {me.role === 'DISTRICT_ADMIN' && (
          <Select allowClear placeholder="All ULBs" style={{ width: 220 }} value={ulbId} onChange={setUlbId} options={ulbs?.map((u) => ({ value: u.id, label: u.name }))} />
        )}
        {manage && me.role !== 'WEB_ADMIN' && <Button type="primary" onClick={() => setEditing('new')} data-testid="new-zone">New event zone</Button>}
      </Space>
      <Card size="small">
        <Table<Zone> rowKey="id" size="middle" loading={isLoading} dataSource={zones} data-testid="zones-table" scroll={{ x: 900 }}
          columns={[
            { title: 'Name', dataIndex: 'name', render: (v, z) => <a onClick={() => setViewing(z.id)}>{v}</a> },
            ...(me.ulbId ? [] : [{ title: 'ULB', dataIndex: 'ulbName' }]),
            { title: 'From', dataIndex: 'startsAt', render: fmt },
            { title: 'To', dataIndex: 'endsAt', render: fmt },
            { title: 'Supervisor', dataIndex: 'supervisorName', render: (v) => v ?? <Typography.Text type="secondary">Area supervisors</Typography.Text> },
            { title: 'Deadline', dataIndex: 'slaHours', render: (v) => (v ? `${v} h` : 'Normal') },
            { title: 'Status', render: (_, z) => status(z) },
            {
              title: '', render: (_, z) => (
                <Space size={4}>
                  <Link href={`/dashboard?eventZoneId=${z.id}`}><Button size="small">Dashboard</Button></Link>
                  {manage && z.active && dayjs(z.endsAt).isAfter(dayjs()) && (
                    <>
                      <Button size="small" onClick={() => setEditing(z)}>Edit</Button>
                      <Popconfirm title="Cancel this event zone?" description="Open complaints go back to the area supervisors." onConfirm={() => cancel(z)}>
                        <Button size="small" danger>Cancel</Button>
                      </Popconfirm>
                    </>
                  )}
                </Space>
              ),
            },
          ]} />
      </Card>
      {editing && <ZoneForm zone={editing === 'new' ? null : editing} tileUrl={tileUrl} onClose={async (saved) => { setEditing(null); if (saved) await mutate(); }} />}
      <ZoneDrawer id={viewing} tileUrl={tileUrl} onClose={() => setViewing(null)} />
    </>
  );
}

function ZoneForm({ zone, tileUrl, onClose }: { zone: Zone | null; tileUrl: string; onClose: (saved: boolean) => void }) {
  const me = useMe();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [geometry, setGeometry] = useState<PolygonGeometry | undefined>(zone?.boundary);
  const [fileError, setFileError] = useState<string | null>(null);
  const formUlb = Form.useWatch('ulbId', form) as string | undefined;
  const ulbId = zone?.ulbId ?? me.ulbId ?? formUlb;
  const { data: ulbs } = useApi<{ id: string; name: string }[]>(!zone && me.role === 'DISTRICT_ADMIN' ? `/masters/districts/${me.districtId}/ulbs` : null);
  const { data: staff } = useApi<{ id: string; name: string; ulbId: string | null; status: string; accessExpiresAt: string | null }[]>('/users?role=SUPERVISOR');
  const { data: boundaries } = useApi<GeoJSON.FeatureCollection>(ulbId ? `/masters/ulbs/${ulbId}/boundaries` : null);
  const supervisors = staff?.filter((s) => s.ulbId === ulbId && s.status === 'ACTIVE' && (!s.accessExpiresAt || dayjs(s.accessExpiresAt).isAfter(dayjs())));

  const save = async (v: { ulbId?: string; name: string; period: [Dayjs, Dayjs]; supervisorId?: string; slaHours?: number }) => {
    if (!geometry) return setFileError('Upload the zone boundary (GeoJSON).');
    const body = {
      name: v.name, boundary: geometry, startsAt: v.period[0].toISOString(), endsAt: v.period[1].toISOString(),
      supervisorId: v.supervisorId ?? null, slaHours: v.slaHours ?? null,
    };
    try {
      if (zone) await api(`/event-zones/${zone.id}`, { method: 'PATCH', body });
      else await api('/event-zones', { method: 'POST', body: { ...body, ulbId, supervisorId: body.supervisorId ?? undefined, slaHours: body.slaHours ?? undefined } });
      message.success('Event zone saved');
      onClose(true);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Modal open width={760} title={zone ? `Edit ${zone.name}` : 'New event zone'} onCancel={() => onClose(false)} onOk={() => form.submit()} okText="Save" destroyOnHidden>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        title="While the zone is running, complaints filed inside it go to its supervisor and get the shorter deadline. When it ends, open complaints go back to the area supervisors automatically." />
      <Form form={form} layout="vertical" onFinish={save}
        initialValues={zone ? { name: zone.name, period: [dayjs(zone.startsAt), dayjs(zone.endsAt)], supervisorId: zone.supervisorId ?? undefined, slaHours: zone.slaHours ?? undefined } : undefined}>
        {!zone && me.role === 'DISTRICT_ADMIN' && (
          <Form.Item name="ulbId" label="ULB" rules={[{ required: true }]}><Select options={ulbs?.map((u) => ({ value: u.id, label: u.name }))} /></Form.Item>
        )}
        <Form.Item name="name" label="Name" rules={[{ required: true, min: 3, max: 120 }]}><Input placeholder="e.g. Rajim Kumbh Mela 2027" /></Form.Item>
        <Form.Item name="period" label="Runs from / to" rules={[{ required: true }]}>
          <DatePicker.RangePicker showTime={{ format: 'HH:mm' }} format="DD MMM YYYY, HH:mm" style={{ width: '100%' }} aria-label="Zone period" />
        </Form.Item>
        <Space style={{ width: '100%' }} styles={{ item: { flex: 1 } }}>
          <Form.Item name="supervisorId" label="Zone supervisor" extra="Empty: complaints stay with the area supervisors.">
            <Select allowClear disabled={!ulbId} options={supervisors?.map((s) => ({ value: s.id, label: s.accessExpiresAt ? `${s.name} (temporary)` : s.name }))} aria-label="Zone supervisor" />
          </Form.Item>
          <Form.Item name="slaHours" label="Deadline inside the zone (hours)" extra="The shorter of this and the complaint type's deadline applies.">
            <InputNumber min={1} max={720} style={{ width: '100%' }} aria-label="Deadline hours" />
          </Form.Item>
        </Space>
        <Form.Item label="Boundary (GeoJSON, WGS84 lng/lat)" extra="A Polygon/MultiPolygon, a Feature, or a FeatureCollection with one polygon. Must overlap the ULB's wards; at most 100 km².">
          <Upload accept=".geojson,.json,application/geo+json,application/json" maxCount={1} showUploadList={false}
            beforeUpload={async (file) => {
              setFileError(null);
              if (file.size > 900_000) { setFileError('File is larger than 900 KB; simplify the boundary first.'); return false; }
              try { setGeometry(extractPolygon(await file.text())); } catch (e) { setFileError((e as Error).message); }
              return false;
            }}>
            <Button icon={<UploadOutlined />} data-testid="zone-upload">Choose GeoJSON file</Button>
          </Upload>
        </Form.Item>
        {fileError && <Alert type="error" showIcon title={fileError} style={{ marginBottom: 12 }} />}
        {(geometry || boundaries) && <BoundaryMap existing={boundaries} preview={geometry as unknown as GeoJSON.Geometry} tileUrl={tileUrl} />}
      </Form>
    </Modal>
  );
}

function ZoneDrawer({ id, tileUrl, onClose }: { id: string | null; tileUrl: string; onClose: () => void }) {
  const { data: z } = useApi<ZoneDetail>(id ? `/event-zones/${id}` : null);
  return (
    <Drawer open={!!id} width={560} title={z?.name} onClose={onClose}>
      {z && (
        <>
          <Descriptions size="small" column={1} bordered items={[
            { label: 'Status', children: status(z) },
            { label: 'ULB', children: z.ulbName },
            { label: 'Runs', children: `${fmt(z.startsAt)} → ${fmt(z.endsAt)}` },
            { label: 'Supervisor', children: z.supervisorName ?? 'Area supervisors' },
            { label: 'Deadline', children: z.slaHours ? `${z.slaHours} hours` : 'Complaint type deadline' },
            { label: 'Area', children: `${(z.areaM2 / 1_000_000).toFixed(2)} km²` },
            { label: 'Complaints', children: <span data-testid="zone-stats">{z.stats.total} total · {z.stats.open} open · {z.stats.overdue} past deadline</span> },
            { label: 'Average disposal', children: z.stats.avgDisposalHours === null ? '—' : `${z.stats.avgDisposalHours} h` },
          ]} />
          <Space style={{ margin: '12px 0' }}>
            <Link href={`/dashboard?eventZoneId=${z.id}`}><Button type="primary">Open dashboard</Button></Link>
            <Link href={`/complaints${qs({ eventZoneId: z.id })}`}><Button>Complaints</Button></Link>
          </Space>
          <BoundaryMap preview={z.boundary as unknown as GeoJSON.Geometry} tileUrl={tileUrl} />
        </>
      )}
    </Drawer>
  );
}
