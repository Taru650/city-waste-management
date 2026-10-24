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
| Server-side revocation | `token_version` checked on every request; role read from DB, not token | `security/authentication` forged role, logout-all |
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

## Known gaps (tracked, must close before go-live)
- ~~Email transport~~ — closed in M4 (SMTP, TLS required in production).
- ~~MFA recovery~~ — closed in M4 (this was listed for M3 but slipped; recovery codes, manager reset and break-glass CLI now exist).
- **Breached-password check:** still the small embedded deny-list. The HIBP k-anonymity check was listed for M3 and has not been done; it needs outbound access to api.pwnedpasswords.com from the API (M5).
- **Key rotation:** PII key rotation (re-encrypt job) is not implemented yet (M5).
- **DAST and pentest:** OWASP ZAP, MobSF, external pentest and CERT-In audit are scheduled in M9.
- **CAPTCHA:** server-side verifier is implemented; the apps must send the token (M6/M7).
- **Device attestation:** device keys are accepted without Play Integrity / App Attest verification (`integrity_verdict = UNVERIFIED`). A rooted phone could extract its key and sign arbitrary files. Add Play Integrity verification at device registration before go-live (M7).
- **Bucket policy:** the bucket must be private with no public-read policy; this is deployment configuration (compose sets it for MinIO) and is not covered by tests.
