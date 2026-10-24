# Delivery milestones

A milestone is done only when its features **and** their tests (unit + integration +
security) pass in CI. The next milestone does not start until then.

| # | Milestone | Status |
|---|-----------|--------|
| M1 | API foundation, auth, sessions, staff hierarchy | ✅ Done |
| M2 | Masters (LGD codes, ward polygons, areas) and complaint lifecycle | ✅ Done |
| M3 | Camera-only media pipeline (capture signature, upload, compression) | ✅ Done |
| M4 | SLA timers, escalation, auto-close job, push notifications | ✅ Done |
| M5 | Reports and analytics (pendency, ageing, disposal time, quality, exports) | ⏭ Next |
| M6 | Next.js web portal (admins, supervisors) | Planned |
| M7 | Flutter Citizen app and Staff app | Planned |
| M8 | Event zones, worker offline sync, load test (k6, 10× peak) | Planned |
| M9 | Security sign-off: DAST (OWASP ZAP), MobSF, external pentest, CERT-In audit, pilot ULB | Planned |

---

## M1 — Foundation and authentication ✅
**Delivered**
- NestJS API under `apps/api`, one REST API (`/api/v1`) for mobile apps and web portal (Bearer tokens for both; the portal holds them in httpOnly cookies on its Next.js server).
- PostgreSQL 16 + PostGIS schema via migrations.
- Citizen registration (no OTP in v1, status `UNVERIFIED_MOBILE` so OTP can be added without schema change).
- Login by mobile or email; Argon2id; lockout after 5 failures for 15 min; uniform errors.
- 15-min JWT access token bound to `token_version`, rotating refresh tokens with reuse detection.
- Mandatory TOTP MFA for Web/District/Sub Admin, with replay protection.
- Password reset by email (single-use, 15 min, hashed), helpdesk reset by the Sub Admin, forced change of temporary passwords; every reset signs the user out everywhere.
- Staff hierarchy: Web Admin → District Admin → Sub Admin → Supervisor/Worker, scoped to jurisdiction.
- PII (mobile, email, TOTP secret) encrypted with AES-256-GCM; lookups by keyed HMAC.
- Helmet headers, strict CORS, body limit, validation whitelist, per-IP rate limits, error sanitising, append-only audit log.

**Exit criteria (met):** `test/auth`, `test/users`, `test/security/*`, unit tests green.

## M2 — Masters and complaint lifecycle ✅
**Delivered**
- Districts / ULBs with **LGD codes**, wards with GeoJSON boundaries (validated by PostGIS), areas → supervisor.
- Public dropdowns (district → ULB → ward), complaint types (Hindi + English) with SLA hours.
- GPS → ward/ULB/district lookup.
- Complaint filing **anywhere** (location decides ward, never the home ward); manual override flagged when > 500 m away.
- Complaint number `DDDD-UUUUUU-YY-NNNNNN` from district LGD + ULB LGD + year + gap-free per-ULB sequence.
- Auto-routing to the area supervisor, otherwise the Sub Admin's PENDING queue.
- State machine: PENDING, ASSIGNED, WORK_IN_PROGRESS, RESOLVED, REJECTED, DUPLICATE, REOPENED, CLOSED.
- Assign / start / resolve (with geofence distance, flag beyond 100 m) / reject / duplicate (with 50 m / 48 h candidates).
- Feedback 1–5 + remark; reopen on rating ≤ 2 within 7 days; 3rd reopen escalates; auto-close after 7 days.
- Daily limit of 10 complaints per citizen.
- Scope isolation for every read and write (citizen / worker / supervisor-area / ULB / district / state).

**Exit criteria (met):** `test/masters`, `test/complaints`, `test/security/authorization` green, including the 40-way concurrent numbering test.

## M3 — Camera-only media pipeline ✅
**Delivered**
- Device keys: EC P-256 per app install (`POST /devices`), max 5 active, revoked by logout-all and password reset.
- Upload flow: `POST /media/upload-url` (pre-signed S3 PUT, type + size signed, 10 min) → `POST /media/:id/confirm` with a signed capture manifest. Contract for the apps: [`MEDIA_CAPTURE_CONTRACT.md`](MEDIA_CAPTURE_CONTRACT.md).
- Server checks: ECDSA signature by the registered key, manifest bound to this upload, capture ≤ 24 h old and not in the future, no mock GPS, accuracy ≤ 100 m, exact size, SHA-256, magic bytes, same capture never accepted twice, ClamAV INSTREAM scan (fail-closed, retryable).
- Compression: photos auto-rotated, ≤ 1920 px, mozjpeg q82, EXIF/GPS stripped, 320 px thumbnail; videos H.264 CRF 26 with the short edge ≤ 720 px, AAC 64 kbps, faststart, metadata stripped, ≤ 30 s, background queue resumed on restart. Decompression-bomb guard (40 MP).
- Measured: 12 MP photo 4.87 MB → 127 KB at SSIM 0.995; 4 s 1080p clip 13.2 MB → 2.5 MB at 720p (fastest preset; production uses `slow`).
- Evidence rules: complaint needs ≥ 1 capture; worker START/RESOLVE need ≥ 1 photo captured after filing; ≤ 5 photos + 1 video per stage; only the capturer can attach, once; distance from the complaint recorded and flagged beyond 100 m.
- `GET /complaints/:id/media`: before/after evidence per stage, 5-minute signed URLs, scoped like the complaint.
- Orphan purge (unattached > 24 h), runnable now and scheduled in M4.
- Infra: MinIO + ClamAV in compose, ffmpeg in the runtime image; CI runs the S3 tests against moto.

**Exit criteria (met):** `test/media` (14), `test/security/media` (31), media unit tests (processor, manifest, magic bytes, clamd) green; full suite 264 tests.

## M4 — SLA, escalation, notifications ✅
**Delivered**
- **Background jobs on BullMQ + Redis.** `PROCESS_ROLE=api|worker|all`; `dist/worker.js` runs jobs without HTTP, so workers scale separately for peak events (`docker compose up --scale worker=N`).
- **SLA sweeper** (every minute): past deadline → `SLA_BREACH` timeline event + supervisor/worker alert (Sub Admins if unrouted); at 2× SLA → `ESCALATE`, `escalated=true`, Sub Admins alerted. Idempotent, survives restarts; a reopen restarts the clock. Filters `?overdue=true`, `?escalated=true`.
- **Scheduled maintenance:** auto-close unrated complaints after 7 days (hourly), purge orphan media (hourly), push-dispatch safety net (30 s).
- **Video transcoding moved to BullMQ:** 3 attempts with exponential backoff for infrastructure errors; bad input rejected at once; owner notified on rejection.
- **Notifications:** in-app inbox (list, unread count, mark read / all read) written in the same transaction as the status change; Hindi by default, English by preference (`PATCH /auth/me/preferences`). Texts carry only the complaint number.
- **Push:** FCM HTTP v1 with service-account OAuth (no SDK); outbox dispatch with retry (5 attempts), unregistered tokens dropped; tokens follow the last account signed in on a phone; removed on logout-all / password reset / disable.
- **Email over SMTP** (nodemailer 10), TLS required in production; mail outages do not change the forgot-password response.
- **MFA recovery:** 10 one-time recovery codes at enrolment (hashed), `POST /auth/mfa/recover`, regenerate with a TOTP code; manager-level `POST /users/:id/reset-mfa`; break-glass CLI for Web Admins (`RESET_ADMIN_MFA_MOBILE=… npm run seed`), audited.
- **Readiness probe** `GET /health/ready` (DB + Redis).

**Exit criteria (met):** `test/sla` (8), `test/notifications` (7), `test/mfa-recovery` (7), `test/mail` (2), `test/security/notifications` (6), push sender and template unit tests; full suite 326 tests, green on three consecutive runs.

## M5 — Reports and analytics
- Materialized views: received/resolved/pending, ageing buckets, date-wise pendency, disposal time (avg/median/P90), SLA compliance, quality (rating, reopen rate, geofence flags, ward mismatch), type mix, heatmap, staff performance, cross-ward complaints.
- Excel / PDF export.
- **Tests:** figures match fixtures; District Admin sees only their district; exports respect scope.

## M6 — Web portal (Next.js)
- Login with MFA, httpOnly cookie session via a BFF route, CSRF protection.
- Masters admin (ward GeoJSON/KML upload with map preview), staff management, complaint inbox and map, dashboards.
- **Tests:** Playwright e2e, CSP check, no tokens in browser storage.

## M7 — Flutter apps
- Citizen: register, file with in-app camera only, track, before/after, feedback.
- Staff: tasks, navigate, start/resolve with camera, offline queue, Hindi UI.
- **Tests:** flutter_test, integration on low-end Android over 3G, MobSF scan, certificate pinning, root detection.

## M8 — Peak events and scale
- Event zones (polygon, dates, temporary staff, tighter SLA); worker offline sync; k6 load test at 10× daily volume in one hour.

## M9 — Security sign-off and pilot
- OWASP ZAP full scan against staging, external pentest, CERT-In-empanelled audit, DPDP consent and deletion flows, pilot in one ULB.
