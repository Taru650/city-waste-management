'use client';

import { Alert, Button, Form, Input } from 'antd';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard } from '@/views/components/AuthCard';
import { call } from '@/views/lib/api';
import { hardNavigate } from '@/views/lib/navigate';
import { safeNext } from '@/views/lib/safe-next';

function LoginForm() {
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(v: { identifier: string; password: string }) {
    setBusy(true);
    setError(null);
    try {
      // session: "cookie" = the API sets httpOnly cookies and never puts a token where page scripts can read it.
      await call('/api/v1/auth/login', { method: 'POST', body: { ...v, session: 'cookie' } });
      hardNavigate(safeNext(params.get('next')));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in">
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} data-testid="login-error" />}
      <Form layout="vertical" onFinish={submit} requiredMark={false}>
        <Form.Item name="identifier" label="Mobile number or email" rules={[{ required: true }]}>
          <Input autoComplete="username" autoFocus />
        </Form.Item>
        <Form.Item name="password" label="Password" rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={busy}>Sign in</Button>
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between' }}>
          <Link href="/forgot-password">Forgot password?</Link>
          <Link href="/privacy">Privacy notice</Link>
        </div>
      </Form>
    </AuthCard>
  );
}

export function Login() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
