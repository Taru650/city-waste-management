'use client';

import { Alert, Button, Checkbox, Form, Image, Input, Space, Typography } from 'antd';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { call } from '@/lib/client/api';
import { hardNavigate } from '@/lib/client/navigate';
import { safeNext } from '@/lib/client/safe-next';

type Step = 'password' | 'totp' | 'recovery' | 'enroll' | 'codes';


function LoginFlow() {
  const params = useSearchParams();
  const [step, setStep] = useState<Step>('password');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState<{ qr: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const done = () => hardNavigate(safeNext(params.get('next')));

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const submitPassword = (v: { identifier: string; password: string }) =>
    run(async () => {
      const r = await call<{ status: string }>('/bff/auth/login', { method: 'POST', body: v });
      if (r.status === 'OK') return done();
      if (r.status === 'MFA_REQUIRED') return setStep('totp');
      const e = await call<{ qr: string; secret: string }>('/bff/auth/mfa-enroll', { method: 'POST', body: {} });
      setEnroll(e);
      setStep('enroll');
    });

  return (
    <AuthCard title={{ password: 'Sign in', totp: 'Authenticator code', recovery: 'Recovery code', enroll: 'Set up two-step verification', codes: 'Save your recovery codes' }[step]}>
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} data-testid="login-error" />}

      {step === 'password' && (
        <Form layout="vertical" onFinish={submitPassword} requiredMark={false}>
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
      )}

      {step === 'totp' && (
        <Form layout="vertical" onFinish={(v) => run(async () => { await call('/bff/auth/mfa-verify', { method: 'POST', body: v }); done(); })}>
          <Typography.Paragraph>Enter the 6-digit code from your authenticator app.</Typography.Paragraph>
          <Form.Item name="code" rules={[{ required: true, pattern: /^\d{6}$/, message: '6 digits' }]}>
            <Input inputMode="numeric" maxLength={6} autoComplete="one-time-code" autoFocus aria-label="Authenticator code" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>Verify</Button>
          <Button type="link" onClick={() => setStep('recovery')} style={{ paddingLeft: 0 }}>Lost your phone? Use a recovery code</Button>
        </Form>
      )}

      {step === 'recovery' && (
        <Form layout="vertical" onFinish={(v) => run(async () => { await call('/bff/auth/mfa-recover', { method: 'POST', body: v }); done(); })}>
          <Typography.Paragraph>Each recovery code works once. Ask your supervising admin to reset two-step verification if you have none left.</Typography.Paragraph>
          <Form.Item name="recoveryCode" rules={[{ required: true }]}>
            <Input placeholder="ABCDE-FGHJK" autoFocus aria-label="Recovery code" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>Sign in</Button>
          <Button type="link" onClick={() => setStep('totp')} style={{ paddingLeft: 0 }}>Back to authenticator code</Button>
        </Form>
      )}

      {step === 'enroll' && enroll && (
        <Form layout="vertical" onFinish={(v) => run(async () => {
          const r = await call<{ recoveryCodes: string[] }>('/bff/auth/mfa-activate', { method: 'POST', body: v });
          setCodes(r.recoveryCodes);
          setStep('codes');
        })}>
          <Typography.Paragraph>Administrators must use two-step verification. Scan this code with Google Authenticator, Microsoft Authenticator or any TOTP app.</Typography.Paragraph>
          <div style={{ textAlign: 'center' }}><Image src={enroll.qr} alt="Authenticator QR code" preview={false} width={220} /></div>
          <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
            Or enter this key: <Typography.Text code copyable data-testid="mfa-secret">{enroll.secret}</Typography.Text>
          </Typography.Paragraph>
          <Form.Item name="code" label="Code shown in the app" rules={[{ required: true, pattern: /^\d{6}$/, message: '6 digits' }]}>
            <Input inputMode="numeric" maxLength={6} autoComplete="one-time-code" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>Turn on</Button>
        </Form>
      )}

      {step === 'codes' && (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Alert type="warning" showIcon title="These codes are shown only once. Store them somewhere safe, away from your phone." />
          <pre data-testid="recovery-codes" style={{ background: '#f6f6f6', padding: 12, borderRadius: 6, columns: 2, fontSize: 15 }}>{codes.join('\n')}</pre>
          <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)}>I have saved my recovery codes</Checkbox>
          <Button type="primary" block disabled={!saved} onClick={done}>Continue</Button>
        </Space>
      )}
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginFlow />
    </Suspense>
  );
}
