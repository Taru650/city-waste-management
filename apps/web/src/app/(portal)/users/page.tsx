'use client';

import { App, Alert, Button, Card, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { api, qs, useApi } from '@/lib/client/api';
import { ROLE_LABELS } from '@/lib/client/format';
import { useMe } from '@/lib/client/session';
import { PageHeader } from '@/components/PageHeader';

interface Staff { id: string; role: string; status: string; name: string; mobile: string; districtId: string | null; ulbId: string | null; mfaEnabled: boolean; lastLoginAt: string | null; accessExpiresAt: string | null }

const CREATABLE: Record<string, string[]> = { WEB_ADMIN: ['DISTRICT_ADMIN'], DISTRICT_ADMIN: ['SUB_ADMIN'], SUB_ADMIN: ['SUPERVISOR', 'WORKER'] };
const MFA_ROLES = ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN'];

export default function StaffPage() {
  const me = useMe();
  const { message, modal } = App.useApp();
  const [role, setRole] = useState<string | undefined>();
  const { data, mutate, isLoading } = useApi<Staff[]>(`/users${qs({ role })}`);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  const creatable = CREATABLE[me.role] ?? [];
  const { data: districts } = useApi<{ id: string; name: string }[]>(me.role === 'WEB_ADMIN' ? '/masters/districts' : null);
  const { data: ulbs } = useApi<{ id: string; name: string }[]>(me.role === 'DISTRICT_ADMIN' ? `/masters/districts/${me.districtId}/ulbs` : null);
  const ulbName = (id: string | null) => ulbs?.find((u) => u.id === id)?.name;

  const showSecret = (title: string, password: string) =>
    modal.info({
      title,
      width: 460,
      content: (
        <>
          <Typography.Paragraph>Give this temporary password to the user in person or by phone. It is shown only once; they must change it at first sign-in.</Typography.Paragraph>
          <Typography.Text code copyable style={{ fontSize: 18 }} data-testid="temp-password">{password}</Typography.Text>
        </>
      ),
    });

  const create = async (v: Record<string, unknown>) => {
    try {
      const body = { ...v, accessExpiresAt: v.accessExpiresAt ? (v.accessExpiresAt as dayjs.Dayjs).toISOString() : undefined };
      const r = await api<{ tempPassword: string }>('/users', { method: 'POST', body: Object.fromEntries(Object.entries(body).filter(([, x]) => x)) });
      setCreating(false);
      form.resetFields();
      await mutate();
      showSecret('Account created', r.tempPassword);
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const action = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      await mutate();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const newRole = Form.useWatch('role', form);

  return (
    <>
      <PageHeader eyebrow="Administration" title="Staff" subtitle="Officers, supervisors and field workers in your jurisdiction" />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="All roles" style={{ width: 200 }} value={role} onChange={setRole}
          options={['DISTRICT_ADMIN', 'SUB_ADMIN', 'SUPERVISOR', 'WORKER'].map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
        {creatable.length > 0 && <Button type="primary" onClick={() => { form.setFieldsValue({ role: creatable[0] }); setCreating(true); }}>Add staff</Button>}
      </Space>
      <Card size="small">
        <Table<Staff> rowKey="id" size="middle" loading={isLoading} dataSource={data} data-testid="staff-table" scroll={{ x: 900 }}
          columns={[
            { title: 'Name', dataIndex: 'name' },
            { title: 'Role', dataIndex: 'role', render: (v) => ROLE_LABELS[v] },
            ...(me.role === 'DISTRICT_ADMIN' ? [{ title: 'ULB', dataIndex: 'ulbId', render: (v: string | null) => ulbName(v) ?? '—' }] : []),
            { title: 'Mobile', dataIndex: 'mobile' },
            {
              title: 'Status', dataIndex: 'status', render: (v, s) => {
                if (v !== 'ACTIVE') return <Tag color="red">{v}</Tag>;
                if (s.accessExpiresAt && dayjs(s.accessExpiresAt).isBefore(dayjs())) return <Tag color="default">Access ended</Tag>;
                if (s.accessExpiresAt) return <Tag color="gold">Temporary until {dayjs(s.accessExpiresAt).format('DD MMM, HH:mm')}</Tag>;
                return <Tag color="green">ACTIVE</Tag>;
              },
            },
            { title: '2-step', dataIndex: 'mfaEnabled', render: (v, s) => (MFA_ROLES.includes(s.role) ? (v ? <Tag color="green">On</Tag> : <Tag color="orange">Not set up</Tag>) : '—') },
            { title: 'Last sign-in', dataIndex: 'lastLoginAt', render: (v) => (v ? dayjs(v).format('DD MMM, HH:mm') : 'Never') },
            {
              title: '', render: (_, s) => creatable.includes(s.role) && (
                <Space size={4} wrap>
                  <Popconfirm title={`${s.status === 'ACTIVE' ? 'Disable' : 'Enable'} ${s.name}?`} description={s.status === 'ACTIVE' ? 'They are signed out immediately.' : undefined}
                    onConfirm={() => action(() => api(`/users/${s.id}/status`, { method: 'PATCH', body: { status: s.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' } }), 'Updated')}>
                    <Button size="small" danger={s.status === 'ACTIVE'}>{s.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button>
                  </Popconfirm>
                  <Popconfirm title="Issue a temporary password?" description="All their sessions end."
                    onConfirm={async () => {
                      try {
                        const r = await api<{ tempPassword: string }>(`/users/${s.id}/reset-password`, { method: 'POST', body: {} });
                        showSecret('Temporary password', r.tempPassword);
                      } catch (e) { message.error((e as Error).message); }
                    }}>
                    <Button size="small">Reset password</Button>
                  </Popconfirm>
                  {MFA_ROLES.includes(s.role) && s.mfaEnabled && (
                    <Popconfirm title="Reset two-step verification?" description="Only if they lost their phone and recovery codes. They must set it up again."
                      onConfirm={() => action(() => api(`/users/${s.id}/reset-mfa`, { method: 'POST', body: {} }), '2-step verification reset')}>
                      <Button size="small">Reset 2-step</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]} />
      </Card>
      <Modal open={creating} title="Add staff" onCancel={() => setCreating(false)} onOk={() => form.submit()} okText="Create" destroyOnHidden>
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          title={me.role === 'SUB_ADMIN' ? 'Staff are created in your ULB.' : 'Each role can only create the role directly below it.'} />
        <Form form={form} layout="vertical" onFinish={create}>
          <Form.Item name="role" label="Role" rules={[{ required: true }]}><Select options={creatable.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} /></Form.Item>
          <Form.Item name="name" label="Full name" rules={[{ required: true, min: 2 }]}><Input /></Form.Item>
          <Form.Item name="mobile" label="Mobile" rules={[{ required: true, pattern: /^[6-9]\d{9}$/, message: '10-digit mobile number' }]}><Input inputMode="numeric" maxLength={10} /></Form.Item>
          <Form.Item name="email" label="Email (needed for self-service password reset)" rules={[{ type: 'email' }]}><Input /></Form.Item>
          {newRole === 'DISTRICT_ADMIN' && (
            <Form.Item name="districtId" label="District" rules={[{ required: true }]}><Select options={districts?.map((d) => ({ value: d.id, label: d.name }))} /></Form.Item>
          )}
          {newRole === 'SUB_ADMIN' && (
            <Form.Item name="ulbId" label="ULB" rules={[{ required: true }]}><Select options={ulbs?.map((u) => ({ value: u.id, label: u.name }))} /></Form.Item>
          )}
          {(newRole === 'SUPERVISOR' || newRole === 'WORKER') && (
            <Form.Item name="accessExpiresAt" label="Temporary staff: access ends (optional)" extra="For event staff. Sign-in stops at this time, including on phones already signed in.">
              <DatePicker showTime={{ format: 'HH:mm' }} format="DD MMM YYYY, HH:mm" style={{ width: '100%' }} aria-label="Access ends"
                disabledDate={(d) => d.isBefore(dayjs(), 'day') || d.isAfter(dayjs().add(1, 'year'))} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}
