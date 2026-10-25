# DAST (OWASP ZAP 2.16.1) — vendor's own run, 2026-10-25

**What was scanned:** the API (all 67 operations imported from its OpenAPI spec) and the portal
(spidered), both **authenticated as a Sub Admin** with TOTP, on the e2e stack (real API, production
portal build, PostgreSQL/PostGIS, Redis, S3 emulator). Harness: [`infra/security`](../../infra/security).
Active scan with ZAP's default policy (injection, XSS, path traversal, command injection, SSRF, etc.).

**Coverage, measured** (a logging proxy between ZAP and the API records every request):
45,778 API requests over 5,147 distinct paths; 41 endpoint templates answered 2xx; statuses: 400 ×35,912
(validation rejected the attack payload), 403 ×6,021 (role checks), 404 ×1,234, 401 ×757, 2xx ×1,852,
**500 ×2** (below). ZAP's generated bodies rarely pass validation, so DAST here mostly proves input
handling; authorisation and business logic are covered by the API's own security tests
(`test/security/*`) and Playwright, and must be covered by the external pentest.

## Findings
| # | Finding | Risk | Status |
|---|---|---|---|
| 1 | Portal `/privacy` returned **500** (antd compound component used from a server component) | Low (availability, error disclosure) | **Fixed** (client component); Playwright test |
| 2 | API `POST/DELETE /notifications/push-tokens` returned **500** for input containing NUL bytes (PostgreSQL rejects U+0000); push tokens accepted any characters up to 4,096 | Low–Medium (error-path robustness; no data exposure) | **Fixed**: a global guard refuses NUL anywhere in body/query/path with 400 (every endpoint), push tokens restricted to FCM's character set ≤ 2,048; regression tests |
| 3 | No CSP on `/_next/static` responses | Medium per ZAP; no practical impact (CSP does not apply to script files) | **Fixed**: `default-src 'none'` on static assets; the confirmation scan then flagged the missing `form-action` (no `default-src` fallback), added with `base-uri`; Playwright test |
| 4 | `style-src 'unsafe-inline'` on portal pages | Medium per ZAP | **Accepted, documented** (antd/Leaflet inject styles; scripts stay nonce-locked). Revisit with antd's CSS-in-JS nonce support |
| 5 | Informational: "user-controllable attribute" (`/login?next=` reflected in a link), suspicious comments in minified JS, modern web app | Info | Reviewed: `next` is validated to same-origin paths and React-escaped (existing tests); comments are library code |

No SQL injection, XSS, path traversal, command injection, SSRF or open redirect was reported.

## Scanner pitfall found along the way (worth telling the auditor)
The first two runs looked clean but were **unauthenticated**: ZAP's replacer does not expand
environment variables, so it sent the literal header `Bearer ${API_TOKEN}` (40,023 of 45,927 API
requests were 401). The harness now renders the plan with real values and records coverage; a
"clean" DAST report without coverage evidence should not be accepted.

## Confirmation scan (after the fixes, same harness and policy)
45,748 API requests over 5,143 distinct paths (same coverage as before); statuses 400 ×36,229,
403 ×5,990, 404 ×1,234, 401 ×751, 2xx ×1,544, **5xx: none**. Alerts: **one Medium**, `style-src
'unsafe-inline'` (accepted, #4), plus 4 informational (#5). The first confirmation pass caught a gap in
fix #3 (`form-action` missing from the static-asset CSP); fixed and rescanned.
