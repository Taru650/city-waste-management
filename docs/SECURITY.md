# Security controls and how they are tested

Every control below has an automated test. Security tests live in `apps/api/test/security/`
and run in CI as a separate gate (`npm run test:security`), alongside dependency audit,
secret scanning (gitleaks) and container scanning (Trivy).

## Authentication and sessions (OWASP ASVS V2, V3)
| Control | Implementation | Test |
|---|---|---|
| Strong password hashing | Argon2id (19 MiB, t=2) | `auth.e2e` "stores … encrypted" |
| Password policy | 8–128 chars, letters + digits, deny-list, not containing mobile/email name | `password-policy.spec`, `auth.e2e` |
| Brute-force protection | 5 failures → 15 min lock; per-IP throttling on all credential endpoints | `security/authentication` lockout, `security/rate-limiting` |
| No account enumeration | identical errors for unknown user / wrong password / locked; identical forgot-password reply; dummy hash verify for timing | `security/authentication` |
| MFA for admins | TOTP mandatory for Web, District and Sub Admin; enrolment before any token; replay blocked | `auth.e2e` MFA block |
| Short-lived access tokens | 15-min HS256 JWT, algorithm pinned, `typ` checked | `security/authentication` forged / alg=none / expired / wrong type |
| Server-side revocation | `token_version` and the token's session (`sid`) checked on every request: sign-out ends that session's access tokens at once, other devices stay signed in; role read from DB, not token | `security/authentication` forged role, sid, logout-all; `auth.e2e` logout |
| Refresh token rotation | single use, stored as SHA-256, reuse revokes the family | `security/authentication` reuse test |
| Password reset | 15-min single-use hashed token, newer link voids older, revokes all sessions | `auth.e2e` reset block |
| Temporary passwords | forced change before any other API use | `auth.e2e`, `users.e2e` |

## Authorisation (OWASP API1 BOLA, API3, API5)
| Control | Implementation | Test |
|---|---|---|
| Jurisdiction scoping | SQL scope predicate on every complaint read/write (citizen → own, worker → assigned, supervisor → own area, Sub Admin → ULB, District Admin → district) | `security/authorization` IDOR matrix |
| No ID probing | out-of-scope resources return 404 | `security/authorization` |
| Function-level access | `@Roles` on every privileged route; District/Web Admin read-only on complaints | `security/authorization`, `complaints.e2e` |
| Hierarchy enforcement | each role creates/manages only one level down, inside its jurisdiction; ULB forced server-side | `users.e2e`, `security/authorization` mass assignment |
| Mass assignment | `whitelist` + `forbidNonWhitelisted` validation | `security/authorization` |
| Staff never see citizen PII | complaint views omit citizen identity | `security/authorization` |

## Data protection
| Control | Implementation | Test |
|---|---|---|
| PII encryption at rest | AES-256-GCM for mobile, email, TOTP secret; HMAC blind index for lookup | `pii-crypto.service.spec`, `auth.e2e` |
| Secrets validated at boot | refuses to start on short/equal secrets or wrong key sizes; CAPTCHA and CORS required in production | `configuration.spec` |
| Tamper-evident history | DB triggers make `complaint_events`, `feedback`, `audit_logs` append-only (incl. TRUNCATE) | `security/audit-integrity` |
| Audit logging | logins, lockouts, resets, MFA, admin changes with actor and IP | `security/audit-integrity` |

## Media uploads (camera-only evidence)
| Control | Implementation | Test |
|---|---|---|
| Only in-app captures | per-install EC P-256 key; ECDSA signature over the capture manifest | `security/media` signature tests, `capture-manifest.spec` |
| No replay | manifest bound to mediaId + deviceId + sha256; a capture is accepted once (unique index) | `security/media` replay / duplicate |
| No gallery or edited photos | capture ≤ 24 h old, not in the future, hash must match the signed one | `security/media` stale / future / hash mismatch |
| No fake location | mock-location flag rejected, accuracy ≤ 100 m; distance from complaint recorded and flagged | `security/media`, `media.e2e` geofence |
| Content-type spoofing | allow-list at upload-url; magic-byte sniffing of the stored object; image must decode | `security/media` PNG/HTML/SVG/ELF/garbage, `file-signature.spec` |
| Resource abuse | size declared and re-checked (8 MB photo / 60 MB video), 40 MP decode limit, 30 s video limit, 20 pending uploads, daily caps, ffmpeg via argv with timeout | `security/media`, `media-processor.spec` |
| Malware | ClamAV INSTREAM; infected → rejected and audited; scanner down → 503, retryable (fail closed) | `security/media` malware block, `malware-scanner.spec` |
| Privacy of stored media | EXIF/GPS stripped from served copies; private bucket; 5-min signed GET URLs; listing scoped like the complaint | `media.e2e`, `security/media` |
| Ownership | only the capturer can confirm/attach their media; devices cannot be shared across accounts | `security/media` ownership, `media.e2e` devices |
| Revocation | device revoke, logout-all and password reset invalidate signing keys | `security/media` revocation |

## Notifications, jobs and recovery
| Control | Implementation | Test |
|---|---|---|
| Notification isolation | inbox and mark-read filtered by owner; others' ids → 404 | `security/notifications` |
| No PII in push | templates carry only the complaint number and status (payload goes to Google, shows on lock screens) | `security/notifications`, `templates.spec` |
| Shared phones | an FCM token belongs to the last account that registered it; sign-out-everywhere deletes tokens | `security/notifications` |
| Transactional notify | notifications written in the action's transaction; rolled-back actions notify nobody | `notifications.e2e` |
| FCM credentials | service-account JWT (RS256) exchanged for short-lived tokens; key only in env/secret store | `push-sender.spec` |
| Email | SMTP with TLS required in production; mail failure cannot reveal account existence | `mail.e2e`, `configuration.spec` |
| MFA recovery | 10 single-use codes stored as keyed hashes; failures count towards lockout; regeneration needs TOTP | `mfa-recovery.e2e` |
| MFA reset | manager in the same jurisdiction only; signs the user out; Web Admin via audited break-glass CLI on the server | `mfa-recovery.e2e` |
| Redis | password-protected, private network (compose); tests use a dedicated DB that the harness refuses to mix up | `infra/docker-compose.yml`, `global-setup.ts` |

## Web portal (apps/web)
| Control | Implementation | Test |
|---|---|---|
| No tokens in the browser | BFF route handlers keep access/refresh tokens in httpOnly, Secure, SameSite=Strict cookies; token-issuing API endpoints are not reachable through the gateway | `e2e/security` cookies + gateway tests, `proxy-rules.test` |
| Gateway bypasses | path normalised like Express (case, duplicate/trailing slashes, `.`/`..`, encoded slashes) before the blocklist | `proxy-rules.test`, `e2e/security` |
| CSRF | SameSite=Strict plus custom header plus Origin / Sec-Fetch-Site check on every state change | `csrf.test`, `e2e/security` |
| XSS | React escaping; CSP `script-src 'self' 'nonce-…' 'strict-dynamic'` with a fresh nonce per request; no `unsafe-inline`/`unsafe-eval` for scripts | `e2e/security` CSP + stored-XSS tests |
| Clickjacking / sniffing | `frame-ancestors 'none'`, X-Frame-Options DENY, nosniff, no-referrer, Permissions-Policy, COOP | `e2e/security` |
| Open redirect | post-login `next` restricted to same-origin paths | `safe-next.test`, `e2e/security` |
| Session refresh races | single-flight refresh + 30 s result reuse so parallel requests never trigger refresh-token reuse detection | `session.test`, `e2e/security` parallel refresh |
| Export safety | formula injection neutralised (CSV/XLSX), no citizen identity, row cap, audited | `report-range.spec`, `test/reports` |
| Report scope | reports use the same jurisdiction predicate as the inbox; filtering by another ULB's id returns nothing | `test/reports` scope tests |

## Mobile apps (apps/mobile_citizen, apps/mobile_staff, packages/flutter_core)
| Control | Implementation | Test |
|---|---|---|
| Camera-only evidence | custom camera screen; no `image_picker`/`file_picker`; storage and media-read permissions removed from the manifest | CI manifest check, widget tests use the capture launcher only |
| Capture integrity | P-256 key in Android Keystore (StrongBox if present), non-exportable; manifest signed per capture; GPS accuracy ≤ 50 m and not mocked before the shutter works | `signer_test`, `uploader_test`, `gps_and_strings_test`, contract test (server accepts the Dart signature, refuses unsigned/mocked/stale) |
| Token storage | `flutter_secure_storage` (Keystore; iOS this-device-only); never logged or shown | `api_client_test` |
| Session refresh | single-flight refresh; failed refresh clears the session | `api_client_test`, contract test |
| Transport | release requires HTTPS + SPKI pins (`assertReleaseReady`); network security config: no cleartext, system CAs only | `api_client_test` pin test with a real certificate |
| Backups / device transfer | `allowBackup=false`, data-extraction rules exclude all domains | CI manifest check |
| Role separation | Citizen app refuses staff; Staff app refuses citizens and administrators (MFA accounts go to the portal) | widget tests, contract test |
| Temporary passwords | Staff app forces the change before any other screen; device key registered only afterwards | widget test, contract test |
| Shared phones | sign-out warns about unsent proof, then deletes the queue and its files | `outbox_test`, staff widget test |
| Rooted phones (Staff app) | native heuristics (test-keys, su/Magisk paths) block the app | `gps_and_strings_test` (channel), staff widget test; Kotlin not yet compiled, see gaps |
| Offline queue | stored in the app's private support directory; captures in app-private storage, deleted after upload or discard | `outbox_test` |

## App attestation (Play Integrity) and bot protection
| Control | Implementation | Test |
|---|---|---|
| Bots on public account endpoints | register / forgot-password need CAPTCHA (portal) **or** a passing Play Integrity verdict (apps); production refuses to start without both configured | `security/attestation` (neither proof → 400, CAPTCHA path, app path) |
| Genuine app, genuine phone | Google decodes the token; we require our package, `PLAY_RECOGNIZED`, our signing-certificate digest, and a device verdict (citizens ≥ BASIC, staff ≥ DEVICE) | `play-integrity.spec` (every rule), `security/attestation` |
| Replay | stateless HMAC challenge (purpose + 10 min expiry); verified nonce stored once | `security/attestation` replay, tampered/wrong-purpose challenges |
| Verdict reuse for another key | device nonce = SHA-256(challenge ‖ public key) | `security/attestation` (verdict for another key refused), contract test |
| Old keys after enforcement | upload-url refuses keys without a passing verdict from the last 30 days; apps re-register through the 428 flow | `security/attestation`, contract test |
| Google unavailable | enforce: 503 (fail closed, retryable); monitor: recorded as UNVERIFIED | `security/attestation` |
| Rollout | `PLAY_INTEGRITY_MODE=monitor` records verdicts without blocking; production requires `enforce` | `security/attestation` monitor mode, `configuration.spec` |
| Portal cannot mint challenges for others | `/attestation/*` blocked at the portal gateway | `proxy-rules.test` |

## Event zones and temporary staff
| Control | Implementation | Test |
|---|---|---|
| Zone management scope | create/edit by Web/District/Sub Admin within jurisdiction (Sub Admin always own ULB); supervisors read only zones they run; workers none | `zones.e2e` jurisdiction |
| Routing integrity | polygon valid, ≤ 100 km², overlapping the ULB's wards, ≤ 92 days; overlapping active zones refused (no ambiguous routing) | `zones.e2e` creation rules |
| Nothing stranded with temporary accounts | when a zone ends or is cancelled, open complaints go back to area supervisors (timeline + notification); zone supervisor must hold access past the zone end | `zones.e2e` handover |
| Temporary staff | `access_expires_at` stops login, open sessions (guard) and refresh at once; hidden from assignment; ≤ 1 year, supervisors/workers only | `zones.e2e` temporary staff, Playwright |

## Privacy (DPDP Act 2023)
| Control | Implementation | Test |
|---|---|---|
| Notice | versioned Hindi/English notice (purpose, data, recipients, retention, rights, Grievance Officer, Data Protection Board); public on the portal and in the app; production refuses to start without a Grievance Officer | `privacy.e2e` notice, Playwright privacy |
| Consent | no account without consent to the current notice version; recorded with version + language in the same transaction as the account; a changed notice asks again before the app can be used | `privacy.e2e` consent, citizen widget tests, contract test |
| Access | `GET /privacy/my-data`: profile, consents, own complaints with history/feedback/own media metadata, devices, notifications — nothing about anyone else; audited | `privacy.e2e` export |
| Correction | name, father/husband name, email (uniqueness enforced); mobile is the identity | `privacy.e2e` correction |
| Erasure / withdrawal | password-confirmed; contact details, name, notifications, push tokens, reset tokens and feedback remarks removed at once, every session and device key revoked; complaints stay anonymous; same mobile can re-register; staff accounts are closed by admins | `privacy.e2e` erasure, contract test |
| Integrity vs. erasure | feedback remains append-only except clearing the remark (database trigger) | `privacy.e2e` |
| Retention | daily job: read notifications after 180 days (unread 360), spent session tokens after 30 days; unattached media after 24 h; security logs kept ≥ 180 days (CERT-In) | `privacy.e2e` retention |

## Input and transport (OWASP A03, A05, API4)
| Control | Implementation | Test |
|---|---|---|
| SQL injection | parameterised queries only; enum/UUID validation | `security/input-hardening` |
| XSS / content sniffing | JSON only, `nosniff`, CSP `default-src 'none'` | `security/input-hardening`, `security/transport-headers` |
| Resource limits | 1 MB body, pagination cap 100, 10 complaints/day/citizen, password length cap | `security/input-hardening`, `complaints.e2e` |
| Error leakage | global filter returns generic 500; parser errors sanitised | `security/input-hardening` |
| Security headers | HSTS (1 y, preload), frame-ancestors none, no-referrer, no-store, no `x-powered-by` | `security/transport-headers` |
| CORS | allow-list of portal origins only | `security/transport-headers` |
| API docs | Swagger disabled in production | `security/transport-headers` |
| Container | non-root user, read-only FS, all capabilities dropped, DB bound to localhost | `infra/docker-compose.yml`, Trivy in CI |

## Findings fixed in M9 (internal testing)
- A wrong authenticator code while signed in (regenerating recovery codes) returned 401, which the portal treats as an expired session: admins were thrown back to the login page for a typo. Now 400 (Playwright test).
- The portal's forgot-password page sent no CAPTCHA token although production requires one: staff self-service reset would have failed. hCaptcha widget added (CSP opened only for hCaptcha, only when configured; unit-tested). **Not tested against the real hCaptcha service.**
- The restore procedure was untested; `infra/ops/restore-drill.sh` now proves restores (also in CI).
- DAST (ZAP, authenticated): NUL bytes caused 500s (global guard, 400 everywhere); push tokens accepted arbitrary characters; `/privacy` 500; no CSP on static assets. All fixed, confirmation scan in [`docs/ops/DAST.md`](ops/DAST.md).
- Availability: the dashboard trend report took 31 s (30 days) / 328 s (1 year) on a year of one ULB's history, enough for officials to tie up database CPU by opening the dashboard. Rewritten: 0.6 s / 2.3 s, with an equivalence test against the old query.

## Findings fixed in M10
- **CI had been red on every push since M1** in two jobs, so the release APKs had never been built and the API image never scanned. The container-scan action (`aquasecurity/trivy-action`) no longer resolved: its tags were force-pushed to credential-stealing code in March 2026 (GHSA-69fq-xp46-6x23). Our job never executed it (it failed at resolution). Every action is now pinned to a commit SHA, trivy-action to the unaffected v0.35.0 with Trivy v0.69.3.
- **API image:** the npm bundled with the Node base image carried every HIGH finding; package managers are removed from the runtime image (scan now clean).
- **Deployment:** migrations and the first-admin seed only existed as ts-node scripts that the production image does not contain; compiled scripts and a compose `migrate` step now run them.

## Findings fixed in the October 2026 audit
Details, measurements and the failure drill: [`docs/ops/AUDIT-2026-10.md`](ops/AUDIT-2026-10.md).
- **Sign-out did not end the session's access tokens** (ASVS V3.3.1): a copied access token worked for up to 15 minutes after logout. Tokens are now bound to their session.
- **Portal redirect loop** for a browser holding a token the API rejects (disabled account, password changed elsewhere): fixed with a session-ended handover that refreshes once or signs out.
- **Availability:** a 50,000-row Excel export could exhaust API memory (now streamed, one per user); no database timeouts (now bounded); a Redis outage hung complaint actions and shutdown (now bounded, 503 where appropriate).
- **Routing integrity:** overlapping ward boundaries are refused; the GPS ward lookup is deterministic.
- **Correction:** the intermittent portal sign-out test failure was a lost click (the menu moved under the pointer), not a session that survived sign-out as earlier reported.

## Known gaps (tracked, must close before go-live)
- ~~Email transport~~ — closed in M4 (SMTP, TLS required in production).
- ~~MFA recovery~~ — closed in M4 (this was listed for M3 but slipped; recovery codes, manager reset and break-glass CLI now exist).
- ~~Breached-password check~~ — closed in M10: HIBP k-anonymity range API (5 hex chars of the SHA-1 leave the server, padded responses) on registration, password change and reset; accepts on outage (logged), deny-list always on. **Tested against a local stand-in only**: the real service was not reachable from the build environment. Production must choose `BREACHED_PASSWORD_CHECK=on|off`.
- ~~Key rotation~~ — closed in M10: previous keys are read while new ones are written, `rotate-pii-keys.js` moves every row (resumable, safe while running); MFA recovery codes must be regenerated after a hash-key change (their plaintext is not stored). Procedure in `docs/ops/INCIDENT_RESPONSE.md`.
- **External pentest and CERT-In audit:** not done. The vendor's own ZAP run (M9) is not a substitute; the auditor must test staging, including authorisation and business logic, and the APKs.
- ~~CAPTCHA in the apps~~ — closed in M8: the apps prove themselves with Play Integrity instead (see above). **Needs from you before go-live:** a Play Console app for each package, the linked Google Cloud project number (`PLAY_CLOUD_PROJECT_NUMBER` in the app builds), a service account with Play Integrity access (`PLAY_INTEGRITY_SERVICE_ACCOUNT_B64`) and the release certificate digests (`PLAY_INTEGRITY_CERT_SHA256`). Default quota is 10,000 decodes/day; device keys are re-attested only every 30 days to stay well inside it.
- ~~Device attestation (Android)~~ — closed in M8. **iOS** still has no App Attest: with enforcement on, iOS keys are refused.
- **Portal styles:** `style-src` allows `'unsafe-inline'` (antd injects CSS at runtime; Leaflet sets style attributes). Script injection remains blocked by the nonce CSP.
- **Portal replicas:** refresh single-flight is per process; run one portal replica or use sticky sessions until a shared lock is added.
- **Portal exposure:** the portal forwards `X-Forwarded-For` to the API; it must only be reachable through the TLS/WAF proxy, never directly.
- **Map tiles:** the default OpenStreetMap tile server is for light use only (OSM tile usage policy). Production needs MapmyIndia/Bhuvan or self-hosted tiles via `MAP_TILE_URL`.
- **Bucket policy:** the bucket must be private with no public-read policy; this is deployment configuration (compose sets it for MinIO) and is not covered by tests.
- **Mobile builds not yet verified on a device:** release APKs build in CI since M10 (R8, merged permissions checked), but nothing has run on a phone.
- **Root detection is a heuristic:** Magisk DenyList and similar tools hide root from app-side checks. Treat it as friction; Play Integrity on the server is the control.
- **iOS:** no Secure Enclave signer yet; the iOS build would fail to register a device key. Android-first per the plan.
- **Push notifications:** token registration is built (M8) but untested against a real Firebase project (files not committed); until one exists the apps fall back to polling the in-app inbox.
- **MobSF / dynamic testing of the APKs:** not done; needs the release APKs from the CI job, which has not run yet. Part of the external audit.
- **Push token API:** the apps use FCM registration tokens, which firebase_messaging 17 deprecates in favour of Installation-ID direct send. Migrate client and server together once a real Firebase project is available to verify against.
- **Privacy notice wording** is a working draft for the ULB/state legal team; it is not legal advice. Bump `NOTICE_VERSION` when it changes.
- **Audit-log retention:** `audit_logs` is append-only and never pruned in the database; archiving entries older than the legal retention period to cold storage is an operations task.
- ~~Server-side consent gate~~ — closed in M10: without consent to the current notice the API answers 403 `CONSENT_REQUIRED` to everything but account/session management, the privacy rights and device keys (checked in the same query as the session, no extra round trip); the app switches to the consent screen mid-session.
- **API memory:** RSS grew ~0.8 MB/min during the 1-hour soak (433 → 473 MB). Not shown to be a leak; alert at 1 GB in the pilot and take a heap snapshot if it keeps growing. Compose now caps the API at 1 GB with automatic restart, so a leak shows up as restarts: watch for them.
