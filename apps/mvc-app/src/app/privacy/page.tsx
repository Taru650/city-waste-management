import { PrivacyService } from '@/services/PrivacyService';
import { Notice, PrivacyNotice } from '@/views/components/PrivacyNotice';

/** Public DPDP privacy notice (the same text the apps show), English and Hindi. */
export default async function PrivacyPage() {
  const notice = (await Promise.resolve(PrivacyService.notice()).catch(() => null)) as Notice | null;
  return <PrivacyNotice n={notice} />;
}
