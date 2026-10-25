import { backend } from '@/lib/server/backend';
import { Notice, PrivacyNotice } from './PrivacyNotice';

/** Public DPDP privacy notice (the same text the Citizen app shows), English and Hindi. */
export default async function PrivacyPage() {
  const res = await backend('/privacy/notice').catch(() => null);
  const n = res?.ok ? ((await res.json()) as Notice) : null;
  return <PrivacyNotice n={n} />;
}
