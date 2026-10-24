'use client';

import { Alert, Button, Form, Input } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { call } from '@/lib/client/api';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AuthCard title="Reset password">
      {sent ? (
        <Alert type="success" showIcon title="If an account with an email exists, a reset link has been sent. It is valid for 15 minutes." />
      ) : (
        <Form layout="vertical" onFinish={async (v) => {
          setBusy(true);
          await call('/bff/auth/forgot-password', { method: 'POST', body: v }).catch(() => undefined);
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
