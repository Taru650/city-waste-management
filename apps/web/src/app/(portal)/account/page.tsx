'use client';

import { App, Alert, Button, Card, Col, Descriptions, Form, Input, Modal, Popconfirm, Row, Segmented, Typography } from 'antd';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, call } from '@/lib/client/api';
import { ROLE_LABELS } from '@/lib/client/format';
import { useMe } from '@/lib/client/session';
import { hardNavigate } from '@/lib/client/navigate';
import { PageHeader } from '@/components/PageHeader';

function Account() {
  const me = useMe();
  const { message } = App.useApp();
  const mustChange = useSearchParams().get('mustChange') === '1' || me.mustChangePassword;
  const [pwForm] = Form.useForm();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [askCode, setAskCode] = useState(false);
  const [codeForm] = Form.useForm();

  const changePassword = async (v: { currentPassword: string; newPassword: string }) => {
    try {
      await call('/bff/auth/change-password', { method: 'POST', body: { currentPassword: v.currentPassword, newPassword: v.newPassword } });
      message.success('Password changed. Other sessions were signed out.');
      pwForm.resetFields();
      if (mustChange) hardNavigate('/dashboard');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Your profile" title="Account" subtitle="Password, two-step verification and preferences" />
      {mustChange && <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="Set your own password to continue. The temporary password stops working once you do." data-testid="must-change" />}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="Profile">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="Name">{me.name}</Descriptions.Item>
              <Descriptions.Item label="Role">{ROLE_LABELS[me.role]}</Descriptions.Item>
              <Descriptions.Item label="Mobile">{me.mobile}</Descriptions.Item>
              <Descriptions.Item label="Email">{me.email ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Notification language">
                <Segmented value={me.preferredLanguage} options={[{ value: 'hi', label: 'हिन्दी' }, { value: 'en', label: 'English' }]}
                  onChange={async (v) => { await api('/auth/me/preferences', { method: 'PATCH', body: { preferredLanguage: v } }); message.success('Saved'); }} />
              </Descriptions.Item>
            </Descriptions>
          </Card>
          {me.mfaEnabled && (
            <Card size="small" title="Two-step verification" style={{ marginTop: 12 }}>
              <Typography.Paragraph>
                Recovery codes left: <b data-testid="codes-left">{me.recoveryCodesRemaining}</b>. Generate a new set if you used several or think they were seen by someone else.
              </Typography.Paragraph>
              <Button onClick={() => setAskCode(true)}>New recovery codes</Button>
              {codes && (
                <Alert type="warning" showIcon style={{ marginTop: 12 }} title="Shown once — store them safely. Old codes no longer work."
                  description={<pre data-testid="new-codes" style={{ columns: 2 }}>{codes.join('\n')}</pre>} />
              )}
            </Card>
          )}
          <Card size="small" title="Sessions" style={{ marginTop: 12 }}>
            <Popconfirm title="Sign out on every device, including this one?" onConfirm={async () => {
              await api('/auth/logout-all', { method: 'POST', body: {} }).catch(() => undefined);
              await call('/bff/auth/logout', { method: 'POST', body: {} });
              hardNavigate('/login');
            }}>
              <Button danger>Sign out everywhere</Button>
            </Popconfirm>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="Change password">
            <Form form={pwForm} layout="vertical" onFinish={changePassword}>
              <Form.Item name="currentPassword" label={mustChange ? 'Temporary password' : 'Current password'} rules={[{ required: true }]}>
                <Input.Password autoComplete="current-password" />
              </Form.Item>
              <Form.Item name="newPassword" label="New password" extra="At least 8 characters with letters and numbers; not your mobile number." rules={[{ required: true, min: 8 }]}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Form.Item name="confirm" label="Confirm new password" dependencies={['newPassword']} rules={[{ required: true }, ({ getFieldValue }) => ({
                validator: (_, v) => (v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('Passwords do not match'))),
              })]}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit">Change password</Button>
            </Form>
          </Card>
        </Col>
      </Row>
      <Modal open={askCode} title="Confirm with your authenticator" onCancel={() => setAskCode(false)} onOk={() => codeForm.submit()} destroyOnHidden>
        <Form form={codeForm} onFinish={async (v) => {
          try {
            const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { method: 'POST', body: v });
            setCodes(r.recoveryCodes);
            setAskCode(false);
          } catch (e) { message.error((e as Error).message); }
        }}>
          <Form.Item name="code" rules={[{ required: true, pattern: /^\d{6}$/, message: '6 digits' }]}><Input inputMode="numeric" maxLength={6} placeholder="123456" /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export default function AccountPage() {
  return <Suspense><Account /></Suspense>;
}
