'use client';

import { App, Alert, Button, Card, Col, Descriptions, Form, Input, Popconfirm, Row, Segmented } from 'antd';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, call } from '@/views/lib/api';
import { ROLE_LABELS } from '@/views/lib/format';
import { useMe } from '@/views/lib/session';
import { hardNavigate } from '@/views/lib/navigate';
import { PageHeader } from '@/views/components/PageHeader';

function AccountPage() {
  const me = useMe();
  const { message } = App.useApp();
  const mustChange = useSearchParams().get('mustChange') === '1' || me.mustChangePassword;
  const [pwForm] = Form.useForm();

  const changePassword = async (v: { currentPassword: string; newPassword: string }) => {
    try {
      await call('/api/v1/auth/change-password', { method: 'POST', body: { currentPassword: v.currentPassword, newPassword: v.newPassword, session: 'cookie' } });
      message.success('Password changed. Other sessions were signed out.');
      pwForm.resetFields();
      if (mustChange) hardNavigate('/dashboard');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Your profile" title="Account" subtitle="Password and preferences" />
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
          <Card size="small" title="Sessions" style={{ marginTop: 12 }}>
            <Popconfirm title="Sign out on every device, including this one?" onConfirm={async () => {
              await api('/auth/logout-all', { method: 'POST', body: {} });
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
    </>
  );
}

export function Account() {
  return <Suspense><AccountPage /></Suspense>;
}
