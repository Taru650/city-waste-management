'use client';

import { Alert, Button, Form, Input } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import { AuthCard } from '@/views/components/AuthCard';
import { call } from '@/views/lib/api';

export function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AuthCard title="Reset password">
      {sent ? (
        <Alert type="success" showIcon title="If an account with an email exists, a reset link has been sent. It is valid for 15 minutes." />
      ) : (
        <Form layout="vertical" onFinish={async (v) => {
          setBusy(true);
          // The answer is the same whether or not the account exists, so a failure is not shown either.
          await call('/api/v1/auth/forgot-password', { method: 'POST', body: v }).catch(() => undefined);
          setBusy(false);
          setSent(true);
        }}>
          <Form.Item name="identifier" label="Mobile number or email" rules={[{ required: true }]}><Input autoFocus /></Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>Send reset link</Button>
        </Form>
      )}
      <div style={{ marginTop: 12 }}><Link href="/login">Back to sign in</Link></div>
    </AuthCard>
  );
}
