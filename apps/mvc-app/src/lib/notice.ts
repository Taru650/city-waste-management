/**
 * Privacy notice version. Bump it when the notice text changes: every citizen is then asked to accept
 * the new version before they can continue (DPDP Act 2023). The wording shown to citizens lives in
 * src/services/PrivacyService.ts and is a working draft for the ULB/state legal team.
 */
export const NOTICE_VERSION = '2026-10-v1';
export const CONSENT_PURPOSE = 'GRIEVANCE_SERVICE';
export const consentNoticeVersion = () => NOTICE_VERSION;
