'use client';

import { App, Alert, Button, Card, Col, Descriptions, Empty, Form, Image, Input, Modal, Rate, Row, Select, Space, Tag, Timeline, Typography } from 'antd';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import type { ComplaintItem } from '../page';
import { api, useApi } from '@/lib/client/api';
import { fmtDateTime, ROLE_LABELS, STATUS_COLORS, STATUS_LABELS } from '@/lib/client/format';
import { canTriage, useMe } from '@/lib/client/session';

const PointMap = dynamic(() => import('@/components/PointMap'), { ssr: false, loading: () => <div style={{ height: 260 }} /> });

interface Detail extends ComplaintItem {
  location: { lat: number; lng: number; accuracyM: number | null };
  district: { name: string };
  resolutionRemark: string | null;
  resolvedAt: string | null;
  duplicateOf: string | null;
  events: { action: string; fromStatus: string | null; toStatus: string; remark: string | null; at: string; actorRole: string | null; actorName: string | null }[];
  feedback: { rating: number; remark: string | null; reopenRequested: boolean; createdAt: string }[];
}
interface Media {
  id: string; stage: 'COMPLAINT' | 'WORK_START' | 'RESOLUTION'; kind: 'PHOTO' | 'VIDEO'; status: string; uploaderRole: string;
  capturedAt: string; location: { lat: number; lng: number }; distanceM: number | null; outsideGeofence: boolean | null;
  url: string | null; thumbnailUrl: string | null;
}

const OPEN = ['PENDING', 'ASSIGNED', 'WORK_IN_PROGRESS', 'REOPENED'];
const STAGES: [Media['stage'], string][] = [['COMPLAINT', 'Reported by citizen'], ['WORK_START', 'Before work'], ['RESOLUTION', 'After work (proof)']];
const ACTION_LABEL: Record<string, string> = {
  CREATE: 'Filed', ROUTE: 'Routed to supervisor', ASSIGN: 'Assigned', START: 'Work started', RESOLVE: 'Resolved', REJECT: 'Rejected',
  MARK_DUPLICATE: 'Marked duplicate', CLOSE: 'Closed by citizen', REOPEN: 'Reopened by citizen', AUTO_CLOSE: 'Auto-closed',
  SLA_BREACH: 'SLA deadline missed', ESCALATE: 'Escalated', HANDOVER: 'Event zone ended: handed to area supervisor',
};

export function ComplaintDetail({ id, tileUrl }: { id: string; tileUrl: string }) {
  const me = useMe();
  const { message } = App.useApp();
  const { data: c, mutate, error } = useApi<Detail>(`/complaints/${id}`);
  const { data: media } = useApi<Media[]>(`/complaints/${id}/media`);
  const [dialog, setDialog] = useState<'assign' | 'reject' | 'duplicate' | 'resolve' | null>(null);

  if (error) return <Alert type="error" showIcon title={error.message} />;
  if (!c) return <Card loading />;

  const act = async (path: string, body: object) => {
    try {
      await api(`/complaints/${id}/${path}`, { method: 'POST', body });
      message.success('Saved');
      setDialog(null);
      await mutate();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const open = OPEN.includes(c.status);
  const points = [
    { ...c.location, label: 'Complaint location', color: '#cf1322' },
    ...(media ?? []).filter((m) => m.stage === 'RESOLUTION').map((m) => ({ ...m.location, label: `Proof photo · ${m.distanceM ?? '?'} m away`, color: '#1f7a4d' })),
  ];

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Space orientation="vertical" size={0}>
          <Link href="/complaints">← Complaints</Link>
          <Typography.Title level={3} style={{ margin: 0 }} data-testid="complaint-no">{c.complaintNo}</Typography.Title>
          <Space size={4} wrap>
            <Tag color={STATUS_COLORS[c.status]} data-testid="complaint-status">{STATUS_LABELS[c.status]}</Tag>
            {c.slaBreached && open && <Tag color="red">Past SLA</Tag>}
            {c.escalated && <Tag color="red">Escalated</Tag>}
            {c.wardMismatch && <Tag color="gold">Ward chosen far from GPS</Tag>}
            {c.reopenCount > 0 && <Tag color="volcano">Reopened ×{c.reopenCount}</Tag>}
          </Space>
        </Space>
        {canTriage(me) && open && (
          <Space wrap className="no-print">
            <Button type="primary" onClick={() => setDialog('assign')}>{c.worker ? 'Reassign' : 'Assign worker'}</Button>
            <Button onClick={() => setDialog('resolve')} disabled={c.status === 'PENDING'}>Resolve</Button>
            {c.status !== 'WORK_IN_PROGRESS' && <Button onClick={() => setDialog('duplicate')}>Duplicate</Button>}
            {c.status !== 'WORK_IN_PROGRESS' && <Button danger onClick={() => setDialog('reject')}>Reject</Button>}
          </Space>
        )}
      </Space>

      <Row gutter={[12, 12]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={14}>
          <Card size="small" title="Details">
            <Descriptions column={{ xs: 1, md: 2 }} size="small">
              <Descriptions.Item label="Type">{c.type.nameEn} · {c.type.nameHi}</Descriptions.Item>
              <Descriptions.Item label="Filed">{fmtDateTime(c.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="Location">{c.ulb.name}, Ward {c.ward.number}, {c.district.name}</Descriptions.Item>
              <Descriptions.Item label="Landmark">{c.landmark ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="SLA due"><span style={{ color: c.slaBreached ? '#cf1322' : undefined }}>{fmtDateTime(c.slaDueAt)}</span></Descriptions.Item>
              <Descriptions.Item label="Supervisor">{c.supervisor?.name ?? 'Not routed (Sub Admin queue)'}</Descriptions.Item>
              <Descriptions.Item label="Worker">{c.worker?.name ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Resolved">{fmtDateTime(c.resolvedAt)}</Descriptions.Item>
              <Descriptions.Item label="Description" span={2}><Typography.Text data-testid="complaint-description">{c.description}</Typography.Text></Descriptions.Item>
              {c.resolutionRemark && <Descriptions.Item label="Resolution remark" span={2}>{c.resolutionRemark}</Descriptions.Item>}
              {c.duplicateOf && <Descriptions.Item label="Duplicate of" span={2}><Link href={`/complaints/${c.duplicateOf}`}>Original complaint</Link></Descriptions.Item>}
            </Descriptions>
          </Card>

          <Card size="small" title="Evidence (photos and video taken in the app)" style={{ marginTop: 12 }} data-testid="evidence">
            {STAGES.map(([stage, label]) => {
              const items = (media ?? []).filter((m) => m.stage === stage);
              if (!items.length) return null;
              return (
                <div key={stage} style={{ marginBottom: 12 }}>
                  <Typography.Text strong>{label}</Typography.Text>
                  <Image.PreviewGroup>
                    <Space wrap style={{ marginTop: 6, display: 'flex' }}>
                      {items.map((m) => (
                        <div key={m.id} style={{ width: 160 }}>
                          {m.kind === 'PHOTO' && m.url ? (
                            <Image src={m.thumbnailUrl ?? m.url} preview={{ src: m.url }} width={160} height={120} style={{ objectFit: 'cover', borderRadius: 6 }} alt={label} />
                          ) : m.url ? (
                            <video src={m.url} poster={m.thumbnailUrl ?? undefined} controls preload="none" width={160} height={120} style={{ borderRadius: 6, background: '#000' }} />
                          ) : (
                            <div style={{ width: 160, height: 120, display: 'grid', placeItems: 'center', background: '#fafafa' }}>Processing…</div>
                          )}
                          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                            {fmtDateTime(m.capturedAt)} · {ROLE_LABELS[m.uploaderRole]}
                          </Typography.Text>
                          {m.outsideGeofence && <Tag color="red" style={{ marginTop: 2 }}>{m.distanceM} m from complaint</Tag>}
                        </div>
                      ))}
                    </Space>
                  </Image.PreviewGroup>
                </div>
              );
            })}
            {media && media.length === 0 && <Empty description="No media" />}
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card size="small" title="Map" className="no-print"><PointMap points={points} tileUrl={tileUrl} /></Card>
          <Card size="small" title="History" style={{ marginTop: 12 }}>
            <Timeline items={c.events.map((e) => ({
              color: e.action === 'SLA_BREACH' || e.action === 'ESCALATE' || e.action === 'REJECT' ? 'red' : e.action === 'RESOLVE' || e.action === 'CLOSE' ? 'green' : 'blue',
              content: (
                <>
                  <Typography.Text strong>{ACTION_LABEL[e.action] ?? e.action}</Typography.Text>
                  <Typography.Text type="secondary"> · {fmtDateTime(e.at)}</Typography.Text>
                  {e.actorRole && e.actorRole !== 'CITIZEN' && <div style={{ fontSize: 12 }}>{e.actorName} ({ROLE_LABELS[e.actorRole]})</div>}
                  {e.remark && <div style={{ fontSize: 13 }}>“{e.remark}”</div>}
                </>
              ),
            }))} />
          </Card>
          {c.feedback.length > 0 && (
            <Card size="small" title="Citizen feedback" style={{ marginTop: 12 }}>
              {c.feedback.map((f, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <Rate disabled value={f.rating} /> {f.reopenRequested && <Tag color="volcano">Asked to reopen</Tag>}
                  <div><Typography.Text type="secondary">{fmtDateTime(f.createdAt)}</Typography.Text> {f.remark}</div>
                </div>
              ))}
            </Card>
          )}
        </Col>
      </Row>

      {dialog === 'assign' && <AssignDialog c={c} onCancel={() => setDialog(null)} onSubmit={(v) => act('assign', v)} />}
      {dialog === 'reject' && (
        <SimpleDialog title="Reject complaint" field="reason" label="Reason (shown in the history)" onCancel={() => setDialog(null)} onSubmit={(v) => act('reject', v)} danger />
      )}
      {dialog === 'resolve' && (
        <SimpleDialog title="Resolve from the web" field="remark" label="Resolution remark" onCancel={() => setDialog(null)} onSubmit={(v) => act('resolve', v)}
          note="Photo proof can only be captured in the Staff app. Resolving here records a remark only and is shown as such." />
      )}
      {dialog === 'duplicate' && <DuplicateDialog id={id} onCancel={() => setDialog(null)} onSubmit={(v) => act('duplicate', v)} />}
    </>
  );
}

function SimpleDialog({ title, field, label, note, danger, onCancel, onSubmit }: {
  title: string; field: string; label: string; note?: string; danger?: boolean; onCancel: () => void; onSubmit: (v: Record<string, string>) => void;
}) {
  const [form] = Form.useForm();
  return (
    <Modal open title={title} onCancel={onCancel} onOk={() => form.submit()} okButtonProps={{ danger }} okText="Save">
      {note && <Alert type="info" showIcon title={note} style={{ marginBottom: 12 }} />}
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item name={field} label={label} rules={[{ required: true, min: 5, max: 500 }]}><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item>
      </Form>
    </Modal>
  );
}

function AssignDialog({ c, onCancel, onSubmit }: { c: Detail; onCancel: () => void; onSubmit: (v: Record<string, string>) => void }) {
  const me = useMe();
  const [form] = Form.useForm();
  const { data: workers } = useApi<{ id: string; name: string; areaName: string | null; openTasks: number }[]>('/users/workers');
  const { data: supervisors } = useApi<{ id: string; name: string }[]>(me.role === 'SUB_ADMIN' ? '/users?role=SUPERVISOR' : null);
  return (
    <Modal open title="Assign" onCancel={onCancel} onOk={() => form.submit()} okText="Assign">
      <Form form={form} layout="vertical" initialValues={{ workerId: c.worker?.id }} onFinish={(v) => onSubmit(Object.fromEntries(Object.entries(v).filter(([, x]) => x)) as Record<string, string>)}>
        {me.role === 'SUB_ADMIN' && (
          <Form.Item name="supervisorId" label="Supervisor (optional)">
            <Select allowClear showSearch optionFilterProp="label" options={supervisors?.map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
        )}
        <Form.Item name="workerId" label="Sanitation worker" rules={[{ required: me.role !== 'SUB_ADMIN' }]}>
          <Select allowClear showSearch optionFilterProp="label" aria-label="Sanitation worker"
            options={workers?.map((w) => ({ value: w.id, label: `${w.name}${w.areaName ? ` · ${w.areaName}` : ''} · ${w.openTasks} open` }))} />
        </Form.Item>
        <Form.Item name="remark" label="Note to worker (optional)"><Input maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  );
}

function DuplicateDialog({ id, onCancel, onSubmit }: { id: string; onCancel: () => void; onSubmit: (v: Record<string, string>) => void }) {
  const [form] = Form.useForm();
  const { data } = useApi<(ComplaintItem & { distanceM: number })[]>(`/complaints/${id}/duplicate-candidates`);
  return (
    <Modal open title="Mark as duplicate" onCancel={onCancel} onOk={() => form.submit()} okText="Merge">
      <Typography.Paragraph type="secondary">Same type within 50 m and 48 hours:</Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item name="duplicateOfId" label="Original complaint" rules={[{ required: true }]}>
          <Select options={data?.map((d) => ({ value: d.id, label: `${d.complaintNo} · ${d.distanceM} m · ${STATUS_LABELS[d.status]}` }))}
            notFoundContent="No nearby candidates" />
        </Form.Item>
        <Form.Item name="remark" label="Note (optional)"><Input maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  );
}
