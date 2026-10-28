import { headers } from 'next/headers';
import { serverConfig } from '@/lib/server/config';
import { ForgotPasswordForm } from './ForgotPasswordForm';

export default async function ForgotPasswordPage() {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <ForgotPasswordForm siteKey={serverConfig.hcaptchaSiteKey} nonce={nonce} />;
}
