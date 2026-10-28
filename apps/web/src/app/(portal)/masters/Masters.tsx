'use client';

import { UploadOutlined } from '@ant-design/icons';
import { App, Alert, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography, Upload } from 'antd';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { api, useApi } from '@/lib/client/api';
import { extractPolygon, PolygonGeometry } from '@/lib/client/geojson';
import { Me, useMe } from '@/lib/client/session';
import { PageHeader } from '@/components/PageHeader';

const BoundaryMap = dynamic(() => import('@/components/BoundaryMap'), { ssr: false, loading: () => <div style={{ height: 380 }} /> });

interface District { id: string; lgdCode: number; name: string; nameHi: string | null }
interface Ulb { id: string; lgdCode: number; type: string; name: string }
interface Ward { id: string; number: number; name: string | null; areaId: string | null; hasBoundary: boolean }
interface Area { id: string; name: string; supervisorId: string | null; supervisorName: string | null; wardIds: string[] }
interface CType { id: string; code: string; nameEn: string; nameHi: string; slaHours: number; active: boolean }

const ULB_TYPES = [
  { value: 'NAGAR_NIGAM', label: 'Nagar Nigam' }, { value: 'NAGAR_PARISHAD', label: 'Nagar Parishad' }, { value: 'NAGAR_PANCHAYAT', label: 'Nagar Panchayat' },
];

export function Masters({ tileUrl }: { tileUrl: string }) {
  const me = useMe();
  const tabs = [
    ...(me.role !== 'SUB_ADMIN' ? [{ key: 'ulbs', label: 'Districts & ULBs', children: <UlbsTab me={me} /> }] : []),
    { key: 'wards', label: 'Wards', children: <WardsTab me={me} tileUrl={tileUrl} /> },
    { key: 'areas', label: 'Areas & supervisors', children: <AreasTab me={me} /> },
    ...(me.role === 'WEB_ADMIN' ? [{ key: 'types', label: 'Complaint types & SLA', children: <TypesTab /> }] : []),
  ];
  return (
    <>
      <PageHeader eyebrow="Administration" title="Masters" subtitle="Jurisdictions, ward boundaries, areas and complaint types" />
      <Tabs items={tabs} />
    </>
  );
}

/** District and ULB pickers for admins above ULB level; Sub Admins are fixed to their ULB. */
function useUlbPicker(me: Me) {
  const [districtId, setDistrictId] = useState<string | undefined>(me.districtId ?? undefined);
  const [ulbId, setUlbId] = useState<string | undefined>(me.ulbId ?? undefined);
  const { data: districts } = useApi<District[]>(me.role === 'WEB_ADMIN' ? '/masters/districts' : null);
  const { data: ulbs, mutate: reloadUlbs } = useApi<Ulb[]>(districtId ? `/masters/districts/${districtId}/ulbs` : null);
  const picker = me.ulbId ? null : (
    <Space wrap style={{ marginBottom: 12 }}>
      {me.role === 'WEB_ADMIN' && (
        <Select placeholder="District" style={{ width: 200 }} value={districtId} onChange={(v) => { setDistrictId(v); setUlbId(undefined); }}
          options={districts?.map((d) => ({ value: d.id, label: `${d.name} (LGD ${d.lgdCode})` }))} />
      )}
      <Select placeholder="ULB" style={{ width: 260 }} value={ulbId} onChange={setUlbId} disabled={!districtId} aria-label="ULB"
        options={ulbs?.map((u) => ({ value: u.id, label: u.name }))} />
    </Space>
  );
  return { districtId, setDistrictId, ulbId, ulbs, districts, reloadUlbs, picker };
}

function UlbsTab({ me }: { me: Me }) {
  const { message } = App.useApp();
  const { districtId, setDistrictId, ulbs, districts, reloadUlbs } = useUlbPicker(me);
  const { mutate: reloadDistricts } = useApi<District[]>(me.role === 'WEB_ADMIN' ? '/masters/districts' : null);
  const [modal, setModal] = useState<'district' | 'ulb' | null>(null);
  const [form] = Form.useForm();
  const save = async (v: Record<string, unknown>) => {
    try {
      if (modal === 'district') await api('/masters/districts', { method: 'POST', body: v });
      else await api('/masters/ulbs', { method: 'POST', body: { ...v, districtId } });
      message.success('Saved');
      setModal(null);
      form.resetFields();
      await Promise.all([reloadDistricts(), reloadUlbs()]);
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  return (
    <Card size="small">
      <Space wrap style={{ marginBottom: 12 }}>
        {me.role === 'WEB_ADMIN' && (
          <>
            <Select placeholder="District" style={{ width: 240 }} value={districtId} onChange={setDistrictId}
              options={districts?.map((d) => ({ value: d.id, label: `${d.name} (LGD ${d.lgdCode})` }))} />
            <Button onClick={() => setModal('district')}>Add district</Button>
          </>
        )}
        <Button type="primary" disabled={!districtId} onClick={() => setModal('ulb')}>Add ULB</Button>
      </Space>
      <Table<Ulb> size="small" rowKey="id" dataSource={ulbs} pagination={false} scroll={{ x: 'max-content' }}
        columns={[
          { title: 'ULB', dataIndex: 'name' },
          { title: 'Type', dataIndex: 'type', render: (v) => ULB_TYPES.find((t) => t.value === v)?.label },
          { title: 'LGD code', dataIndex: 'lgdCode' },
        ]} />
      <Modal open={!!modal} title={modal === 'district' ? 'Add district' : 'Add ULB'} onCancel={() => setModal(null)} onOk={() => form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="lgdCode" label="LGD code" extra="Local Government Directory code (lgdirectory.gov.in)" rules={[{ required: true }]}>
            <InputNumber min={1} max={modal === 'district' ? 9999 : 999999} style={{ width: '100%' }} />
          </Form.Item>
          {modal === 'ulb' && <Form.Item name="type" label="Type" rules={[{ required: true }]}><Select options={ULB_TYPES} /></Form.Item>}
          <Form.Item name="name" label="Name (English)" rules={[{ required: true, min: 2 }]}><Input /></Form.Item>
          <Form.Item name="nameHi" label="Name (Hindi)"><Input /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

function WardsTab({ me, tileUrl }: { me: Me; tileUrl: string }) {
  const { message } = App.useApp();
  const { ulbId, picker } = useUlbPicker(me);
  const { data: wards, mutate } = useApi<Ward[]>(ulbId ? `/masters/ulbs/${ulbId}/wards` : null);
  const { data: boundaries, mutate: reloadBoundaries } = useApi<GeoJSON.FeatureCollection>(ulbId ? `/masters/ulbs/${ulbId}/boundaries` : null);
  const [editing, setEditing] = useState<Ward | 'new' | null>(null);
  const [geometry, setGeometry] = useState<PolygonGeometry | undefined>();
  const [fileError, setFileError] = useState<string | null>(null);
  const [form] = Form.useForm();

  const close = () => { setEditing(null); setGeometry(undefined); setFileError(null); form.resetFields(); };
  const save = async (v: { number?: number; name?: string }) => {
    try {
      if (editing === 'new') await api('/masters/wards', { method: 'POST', body: { ulbId, number: v.number, name: v.name || undefined, boundary: geometry } });
      else if (editing) await api(`/masters/wards/${editing.id}`, { method: 'PATCH', body: { name: v.name || undefined, boundary: geometry } });
      message.success('Ward saved');
      close();
      await Promise.all([mutate(), reloadBoundaries()]);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Card size="small">
      {picker}
      {ulbId && (
        <>
          <Space style={{ marginBottom: 12 }}><Button type="primary" onClick={() => setEditing('new')}>Add ward</Button></Space>
          <Alert type="info" showIcon style={{ marginBottom: 12 }}
            title="Ward boundaries drive automatic routing: a complaint's GPS point decides its ward. Wards without a boundary can only be chosen manually by citizens." />
          <Table<Ward> size="small" rowKey="id" dataSource={wards} pagination={false} scroll={{ x: 'max-content' }}
            columns={[
              { title: 'Ward', dataIndex: 'number', width: 80 },
              { title: 'Name', dataIndex: 'name', render: (v) => v ?? '—' },
              { title: 'Boundary', dataIndex: 'hasBoundary', render: (v) => (v ? <Tag color="green">Mapped</Tag> : <Tag color="orange">Missing</Tag>) },
              { title: 'Area', dataIndex: 'areaId', render: (v) => (v ? <Tag>In an area</Tag> : <Tag color="orange">No supervisor area</Tag>) },
              { title: '', render: (_, w) => <Button size="small" onClick={() => { setEditing(w); form.setFieldsValue({ name: w.name }); }}>Edit</Button> },
            ]} />
          <div style={{ marginTop: 12 }}><BoundaryMap existing={boundaries} tileUrl={tileUrl} /></div>
        </>
      )}
      <Modal open={!!editing} width={720} title={editing === 'new' ? 'Add ward' : `Ward ${editing?.number ?? ''}`}
        onCancel={close} onOk={() => form.submit()} okText="Save" destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={save}>
          {editing === 'new' && <Form.Item name="number" label="Ward number" rules={[{ required: true }]}><InputNumber min={1} max={9999} /></Form.Item>}
          <Form.Item name="name" label="Ward name (optional)"><Input maxLength={100} /></Form.Item>
          <Form.Item label="Boundary (GeoJSON, WGS84 lng/lat)" extra="One ward per file: a Polygon/MultiPolygon, a Feature, or a FeatureCollection with one polygon.">
            <Upload accept=".geojson,.json,application/geo+json,application/json" maxCount={1} showUploadList={false}
              beforeUpload={async (file) => {
                setFileError(null);
                if (file.size > 900_000) { setFileError('File is larger than 900 KB; simplify the boundary first.'); return false; }
                try { setGeometry(extractPolygon(await file.text())); } catch (e) { setFileError((e as Error).message); setGeometry(undefined); }
                return false;
              }}>
              <Button icon={<UploadOutlined />}>Choose GeoJSON file</Button>
            </Upload>
          </Form.Item>
          {fileError && <Alert type="error" showIcon title={fileError} style={{ marginBottom: 12 }} />}
          {geometry && <BoundaryMap existing={boundaries} preview={geometry as unknown as GeoJSON.Geometry} tileUrl={tileUrl} />}
        </Form>
      </Modal>
    </Card>
  );
}

function AreasTab({ me }: { me: Me }) {
  const { message } = App.useApp();
  const { ulbId, picker } = useUlbPicker(me);
  const { data: areas, mutate } = useApi<Area[]>(ulbId ? `/masters/ulbs/${ulbId}/areas` : null);
  const { data: wards } = useApi<Ward[]>(ulbId ? `/masters/ulbs/${ulbId}/wards` : null);
  const { data: supervisors } = useApi<{ id: string; name: string; ulbId: string }[]>(ulbId ? '/users?role=SUPERVISOR' : null);
  const [editing, setEditing] = useState<Area | 'new' | null>(null);
  const [form] = Form.useForm();
  const save = async (v: { name: string; supervisorId?: string; wardIds: string[] }) => {
    try {
      if (editing === 'new') await api('/masters/areas', { method: 'POST', body: { ulbId, name: v.name, supervisorId: v.supervisorId, wardIds: v.wardIds ?? [] } });
      else if (editing) await api(`/masters/areas/${editing.id}`, { method: 'PATCH', body: { supervisorId: v.supervisorId ?? '', wardIds: v.wardIds ?? [] } });
      message.success('Area saved');
      setEditing(null);
      form.resetFields();
      await mutate();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const wardLabel = (id: string) => `Ward ${wards?.find((w) => w.id === id)?.number ?? '?'}`;
  return (
    <Card size="small">
      {picker}
      {ulbId && (
        <>
          <Space style={{ marginBottom: 12 }}><Button type="primary" onClick={() => setEditing('new')}>Add area</Button></Space>
          <Table<Area> size="small" rowKey="id" dataSource={areas} pagination={false} scroll={{ x: 'max-content' }}
            columns={[
              { title: 'Area', dataIndex: 'name' },
              { title: 'Supervisor', dataIndex: 'supervisorName', render: (v) => v ?? <Tag color="orange">None — complaints go to Sub Admin</Tag> },
              { title: 'Wards', dataIndex: 'wardIds', render: (ids: string[]) => ids.map((id) => <Tag key={id}>{wardLabel(id)}</Tag>) },
              { title: '', render: (_, a) => <Button size="small" onClick={() => { setEditing(a); form.setFieldsValue({ name: a.name, supervisorId: a.supervisorId ?? undefined, wardIds: a.wardIds }); }}>Edit</Button> },
            ]} />
        </>
      )}
      <Modal open={!!editing} title={editing === 'new' ? 'Add area' : 'Edit area'} onCancel={() => { setEditing(null); form.resetFields(); }} onOk={() => form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label="Area name" rules={[{ required: true }]}><Input disabled={editing !== 'new'} /></Form.Item>
          <Form.Item name="supervisorId" label="Area supervisor">
            <Select allowClear options={supervisors?.filter((s) => s.ulbId === ulbId).map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item name="wardIds" label="Wards in this area">
            <Select mode="multiple" options={wards?.map((w) => ({ value: w.id, label: `Ward ${w.number}${w.name ? ` · ${w.name}` : ''}` }))} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

function TypesTab() {
  const { message } = App.useApp();
  const { data, mutate } = useApi<CType[]>('/masters/complaint-types/all');
  const update = async (id: string, body: Partial<CType>) => {
    try {
      await api(`/masters/complaint-types/${id}`, { method: 'PATCH', body });
      message.success('Saved');
      await mutate();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  return (
    <Card size="small">
      <Table<CType> size="small" rowKey="id" dataSource={data} pagination={false} scroll={{ x: 'max-content' }}
        columns={[
          { title: 'Type', render: (_, t) => <>{t.nameEn}<Typography.Text type="secondary"> · {t.nameHi}</Typography.Text></> },
          { title: 'SLA (hours)', dataIndex: 'slaHours', render: (v, t) => (
            <InputNumber min={1} max={720} defaultValue={v} onBlur={(e) => { const n = Number(e.target.value); if (n && n !== v) update(t.id, { slaHours: n }); }} aria-label={`SLA hours for ${t.nameEn}`} />
          ) },
          { title: 'Active', dataIndex: 'active', render: (v, t) => <Switch checked={v} onChange={(active) => update(t.id, { active })} /> },
        ]} />
    </Card>
  );
}
