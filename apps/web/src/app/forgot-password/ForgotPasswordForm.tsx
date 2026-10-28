'use client';

import { Alert, Button, Form, Input } from 'antd';
import Link from 'next/link';
import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { call } from '@/lib/client/api';

declare global {
  interface Window {
    hcaptcha?: { render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; 'expired-callback': () => void }) => string };
  }
}

/** The API requires CAPTCHA on forgot-password in production; the widget renders only when a site key is configured. */
export function ForgotPasswordForm({ siteKey, nonce }: { siteKey?: string; nonce?: string }) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | undefined>();
  const [scriptReady, setScriptReady] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (siteKey && scriptReady && box.current && window.hcaptcha && !box.current.dataset.rendered) {
      box.current.dataset.rendered = '1';
      window.hcaptcha.render(box.current, { sitekey: siteKey, callback: setToken, 'expired-callback': () => setToken(undefined) });
    }
  }, [siteKey, scriptReady]);
  return (
    <AuthCard title="Reset password">
      {sent ? (
        <Alert type="success" showIcon title="If an account with an email exists, a reset link has been sent. It is valid for 15 minutes." />
      ) : (
        <Form layout="vertical" onFinish={async (v) => {
          setBusy(true);
          await call('/bff/auth/forgot-password', { method: 'POST', body: { ...v, captchaToken: token } }).catch(() => undefined);
          setBusy(false);
          setSent(true);
        }}>
          <Form.Item name="identifier" label="Mobile number or email" rules={[{ required: true }]}><Input autoFocus /></Form.Item>
          {siteKey && (
            <>
              <Script src="https://js.hcaptcha.com/1/api.js?render=explicit" nonce={nonce} onReady={() => setScriptReady(true)} />
              <div ref={box} style={{ marginBottom: 12 }} data-testid="captcha" />
            </>
          )}
          <Button type="primary" htmlType="submit" block loading={busy} disabled={!!siteKey && !token}>Send reset link</Button>
        </Form>
      )}
      <div style={{ marginTop: 12 }}><Link href="/login">Back to sign in</Link></div>
    </AuthCard>
  );
}
