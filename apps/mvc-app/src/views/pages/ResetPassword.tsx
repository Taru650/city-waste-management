'use client';

import { Alert, Button, Form, Input } from 'antd';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard } from '@/views/components/AuthCard';
import { call } from '@/views/lib/api';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<{ done?: boolean; error?: string }>({});
  return (
    <AuthCard title="Choose a new password">
      {state.done ? (
        <Alert type="success" showIcon title="Password changed. You have been signed out everywhere." action={<Link href="/login">Sign in</Link>} />
      ) : (
        <Form layout="vertical" onFinish={async (v) => {
          try {
            await call('/api/v1/auth/reset-password', { method: 'POST', body: { token, newPassword: v.newPassword } });
            setState({ done: true });
          } catch (e) {
            setState({ error: (e as Error).message });
          }
        }}>
          {state.error && <Alert type="error" showIcon title={state.error} style={{ marginBottom: 16 }} />}
          <Form.Item name="newPassword" label="New password" extra="At least 8 characters with letters and numbers"
            rules={[{ required: true, min: 8 }]}><Input.Password autoComplete="new-password" /></Form.Item>
          <Form.Item name="confirm" label="Confirm" dependencies={['newPassword']} rules={[{ required: true }, ({ getFieldValue }) => ({
            validator: (_, v) => (v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('Passwords do not match'))),
          })]}><Input.Password autoComplete="new-password" /></Form.Item>
          <Button type="primary" htmlType="submit" block disabled={!token}>Change password</Button>
        </Form>
      )}
    </AuthCard>
  );
}

export function ResetPassword() {
  return <Suspense><ResetForm /></Suspense>;
}
