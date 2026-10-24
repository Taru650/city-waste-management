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
- **Email transport:** `LogMailService` only logs. An SMTP/SES transport is needed before production (M4).
- **MFA recovery:** no recovery codes and no "reset MFA" by a higher role yet. Needed before admin onboarding (M3).
- **Breached-password check:** small embedded deny-list. Add the HIBP k-anonymity check (M3).
- **Key rotation:** PII key rotation (re-encrypt job) is not implemented yet (M5).
- **DAST and pentest:** OWASP ZAP, MobSF, external pentest and CERT-In audit are scheduled in M9.
- **CAPTCHA:** server-side verifier is implemented; the apps must send the token (M6/M7).
