# Delivery milestones

A milestone is done only when its features **and** their tests (unit + integration +
security) pass in CI. The next milestone does not start until then.

| # | Milestone | Status |
|---|-----------|--------|
| M1 | API foundation, auth, sessions, staff hierarchy | ✅ Done |
| M2 | Masters (LGD codes, ward polygons, areas) and complaint lifecycle | ✅ Done |
| M3 | Camera-only media pipeline (capture signature, upload, compression) | ✅ Done |
| M4 | SLA timers, escalation, auto-close job, push notifications | ✅ Done |
| M5 | Reports and analytics (pendency, ageing, disposal time, quality, exports) | ✅ Done (with M6) |
| M6 | Next.js web portal (admins, supervisors) | ✅ Done |
| M7 | Flutter Citizen app and Staff app | ✅ Done (code + tests; not yet run on a phone, see below) |
| M8 | Play Integrity, event zones + temporary staff, push in apps, load test (k6, 10× peak), APK build in CI | ✅ Done (phone tests carried to M9) |
| M9 | DPDP flows, DAST + fixes, soak, backup/restore drill, pilot runbook and audit pack | ✅ Done (phones, accounts, external audit and pilot need the ULB/state) |
| M10 | Pilot: phone tests, accounts, external pentest + CERT-In audit, go-live in one ULB | ⏭ Next (owner: ULB/state, vendor support) |

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
- Compression: photos auto-rotated, ≤ 1920 px, q82 (mozjpeg; since M8 libjpeg-turbo by default, see load test), EXIF/GPS stripped, 320 px thumbnail; videos H.264 CRF 26 with the short edge ≤ 720 px, AAC 64 kbps, faststart, metadata stripped, ≤ 30 s, background queue resumed on restart. Decompression-bomb guard (40 MP).
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

## M5 + M6 — Reports and the web portal ✅
Built together on request, so reports were shaped by real screens rather than tests alone.

**Reports API** (`/reports/*`, Web/District/Sub Admin and supervisors; same jurisdiction predicate as the complaint inbox)
- Summary: received / resolved / pending / rejected / duplicate / past-SLA / escalated; disposal rate; average, median and P90 disposal hours; assignment lag; SLA compliance; average rating, % satisfied, reopen rate, proofs captured > 100 m away, ward-mismatch rate; complaint-type mix.
- Pendency ageing (< 1, 1–3, 3–7, 7–15, > 15 days) grouped by district / ULB / ward / type / supervisor.
- Date-wise trend: received, resolved and **pending at day end rebuilt from the append-only event history** (correct across reopens).
- Breakdowns by district / ULB / ward / type / supervisor / worker; hotspot grid (~110 m).
- Exports: Excel and CSV (UTF-8 BOM for Hindi), spreadsheet formula injection neutralised, no citizen identity, 50,000-row cap with a clear error, every export audited. IST calendar days; range capped at 366 days.

**Web portal** (`apps/web`, Next.js 16 + antd 6 + ECharts + Leaflet)
- Server-side session layer (BFF): the browser never receives an access or refresh token; httpOnly + Secure + SameSite=Strict cookies; refresh in `proxy.ts` and the API gateway with single-flight protection against rotation-reuse lockouts.
- Login with TOTP; first-time authenticator setup with QR and one-time recovery codes; recovery-code sign-in; forced temporary-password change; forgot/reset password; workers and citizens are directed to the mobile apps.
- Dashboard: KPI tiles, trend, type mix, ageing, performance table by dimension, hotspot map, exports, print-to-PDF.
- Complaints: filterable inbox (status, past SLA, escalated, ward, type), detail with evidence gallery (signed S3 URLs), map with proof locations, timeline, feedback; assign / reassign / resolve (remark only on web) / reject / merge duplicate.
- Masters: districts and ULBs with LGD codes, wards with GeoJSON boundary upload and map preview, areas and supervisors, complaint-type SLAs.
- Staff: create one level down (temporary password shown once), enable/disable, helpdesk password reset, MFA reset. Notifications inbox; account page (language, recovery codes, sign out everywhere).

**Exit criteria (met):** API `test/reports` (11 exact-number tests), new masters/users endpoints; portal unit tests (45: CSRF, proxy rules incl. bypass attempts, single-flight refresh, open-redirect guard, GeoJSON); **30 Playwright tests in a real browser against the real API**, green on repeated runs, including 8 portal security tests and a time-zone regression test.

## M7 — Flutter apps ✅ (not yet run on a phone)
Shared code in `packages/flutter_core`; two apps, `apps/mobile_citizen` (Swachh Seva) and `apps/mobile_staff` (Swachh Seva Staff). Both use the same REST API as the portal; the only API addition was `GET /complaints?open=true` for the staff inbox.

**flutter_core**
- API client (dio): single-flight refresh on 401, session-expired stream, optional certificate pinning (SPKI SHA-256, `CERT_PINS`); release builds refuse to start without HTTPS and pins.
- Tokens in `flutter_secure_storage` (Android Keystore-backed; iOS `first_unlock_this_device`).
- Camera-only capture screen (`camera` plugin; no gallery, no file picker anywhere): shutter blocked until GPS accuracy ≤ 50 m and the fix is not mocked; video ≤ 30 s; compression on the phone (photo short edge 1440 px q80 without EXIF, video 720p) before upload.
- Capture signing: EC P-256 key generated in Android Keystore (StrongBox when available), non-exportable; manifest per [`MEDIA_CAPTURE_CONTRACT.md`](MEDIA_CAPTURE_CONTRACT.md).
- Offline outbox: complaint filing, start-work and resolve are queued with their captures and sent when online; uploaded media ids are remembered so a retry never uploads twice; definite refusals are shown with the server's reason; captures older than 23 h are marked expired. Cleared at sign-out (queued proof belongs to the account that captured it).
- Hindi (default) and English strings.

**Citizen app:** register (district → ULB → ward, no OTP), sign in, forgot password, file a complaint anywhere (ward from GPS, manual district/ULB/ward when no boundary covers the point, never the home ward), my complaints, track by number, before/after evidence, timeline, 1–5 rating with remark and reopen (1–2 stars, within 7 days), notifications, language.

**Staff app:** sign-in for supervisors and workers only (administrators and citizens are sent to the right app), forced change of a temporary password before anything else, root/tamper check on start. Workers: open tasks, navigate (maps app), start work and resolve with camera proof and GPS, offline. Supervisors: area inbox with status / overdue filters, assign a worker (with open-task counts), reject with reason, start/resolve. Buttons follow the API state machine; queued work hides them to prevent double submission.

**Android hardening (both apps):** only INTERNET, CAMERA, RECORD_AUDIO and location permissions; storage and media-read permissions explicitly removed even if a plugin merges them; `allowBackup=false` and data-extraction rules exclude everything; cleartext disabled and user-installed CAs not trusted in release (debug allows `10.0.2.2` only); R8 minify + resource shrinking; release signing only from a git-ignored `key.properties` (no debug-key fallback); minSdk 24.

**Bugs found and fixed while building**
- Staff on a temporary password could not sign in: the app registered its device key straight after login, which the API refuses until the password is changed. Registration now waits; proved against the real API.
- Offline proof could be sent under the wrong account after a sign-out/sign-in on a shared phone. Sign-out now warns about unsent items and clears the queue.
- After queuing proof without signal, the task screen replaced the task with an error. It now keeps the last loaded copy with an offline banner.

**Exit criteria (met here)**
- `flutter analyze` clean for all three packages.
- `flutter_core` 27 unit tests (client refresh/pinning against a real certificate, signer, uploader, outbox incl. clear, GPS gate, strings, integrity channel).
- Citizen app 8 and Staff app 8 widget tests (whole screens against a fake API, real JPEG captures and real signing).
- **Contract test, 9 tests: the real Dart client against the real API** (PostGIS, Redis, S3 emulator): registration, signed capture accepted, GPS routing, assign, start/resolve through the outbox, before/after and feedback, unsigned/mocked/stale captures refused, token refresh, temporary-password flow, `open=true`, administrators blocked.
- CI job `mobile` runs all of the above plus manifest checks (no storage permissions, no backup, no cleartext, no picker packages).

**Not done in M7 (carried to M8)**
- No APK was built and nothing has run on a phone or emulator: the Android SDK download host is blocked in the build environment. The Kotlin (Keystore signing, root checks) and Gradle changes are therefore uncompiled. First action of M8: build in CI with the Android SDK and test on a low-end phone over 3G.
- App CAPTCHA (production blocker, see SECURITY.md); Play Integrity; push notifications (needs the Firebase project files); iOS Secure Enclave signing (Android-first, iOS has no native signer yet); MobSF scan.

## M8 — Attestation, peak events and scale ✅ (device tests still outstanding)
**Play Integrity (closes the M7 production blocker)**
- The apps have no CAPTCHA; they now prove a genuine, Play-recognised copy of our app on a genuine phone. Sign-up and forgot-password accept CAPTCHA (portal) or Play Integrity (apps).
- Device signing keys are attested through a 428 challenge whose nonce is bound to the public key; verdicts are stored and refreshed every 30 days; uploads from unattested keys are refused once enforcing.
- Citizens need `MEETS_BASIC_INTEGRITY` (cheap uncertified phones keep working); staff need `MEETS_DEVICE_INTEGRITY` (their photos are the evidence that work was done).
- Modes `off` / `monitor` / `enforce`; production refuses to start unless enforcing with certificate digests configured. Google unreachable → 503 when enforcing (fail closed).

**Event zones and temporary staff**
- Zones (polygon, time window, optional zone supervisor, tighter deadline) per ULB. Complaints filed inside a running zone go to the zone supervisor with min(type, zone) deadline.
- Rules: valid polygon, ≤ 100 km², must overlap the ULB's wards, ≤ 92 days, no overlapping active zones; zone supervisor's access must outlast the zone.
- When a zone ends or is cancelled, open complaints go back to the area supervisors (timeline `HANDOVER` + notification), every 5 minutes, idempotent.
- Temporary staff: an access end time stops sign-in, open sessions and refresh at once.
- Portal: Event zones page (GeoJSON upload with map preview, stats drawer, cancel), zone dashboard (`/dashboard?eventZoneId=`), zone filter on dashboard and inbox, temporary staff in the staff form. Apps show the zone on the task.

**Push notifications in the apps:** FCM token registered after sign-in (and on rotation), removed at sign-out; foreground pushes refresh lists, tapped pushes open the complaint. Firebase settings come from `--dart-define`; without them the apps use the in-app inbox only.

**Android build verification:** `tool/kotlin_check.sh` type-checks both apps' Kotlin against real Android framework classes and Flutter's embedding (compile-only stubs only for Google-Maven libraries); CI job `android` builds signed release APKs with R8 and fails if storage/media permissions survive manifest merging.

**Load test (k6, `infra/load`, details in [`infra/load/RESULTS.md`](../infra/load/RESULTS.md))** — target 10× daily volume in one hour = 2.8 complaints/s, each with three signed, fully verified photos (filing, start, resolve), plus supervisors, workers and dashboards, all on one 4-core machine together with k6:
- 1× target for 10 minutes: 1,763 filed, 1,749 resolved, **0 failed requests**, all thresholds met (filing p95 103 ms, media confirm p95 1.2 s).
- The step test found the bottleneck: mozjpeg photo re-encoding (~300 ms CPU per photo). At 2× it pushed confirm p95 to 7.7 s. With libjpeg-turbo (~40 ms, ~50 % larger files, same visual quality) 2× passes with confirm p95 333 ms at 1.4 cores. Default is now `PHOTO_ENCODER=turbo`.
- Knee at ~3× target on this box (filing p95 3.4 s at 4×): machine saturated, plus gap-free per-ULB numbering serialises filings in a single ULB by design.

**Exit criteria**
- API: 17 attestation e2e (enforce + monitor), 15 event-zone/temporary-staff e2e, verdict and config unit tests; full suite green.
- Dart: attestation and push unit tests; contract test (10) runs the real API **with Play Integrity enforced** against a fake Google and fails if enforcement is not actually on.
- Portal: 32 Playwright tests incl. event zone creation in the browser and temporary staff.

**Still not done**
- Nothing has run on a phone yet, and the CI APK job has not run (no PR). Low-end phone over 3G testing moves to M9.
- iOS: no App Attest, so iOS keys are refused when enforcing.

## M9 — Pilot readiness ✅ what can be done without phones, accounts and auditors
**Done**
- **DPDP Act 2023:** versioned Hindi/English privacy notice (public on the portal and in the app), consent recorded at registration (no account without it) and asked again when the notice changes, data export, correction, password-confirmed erasure that also withdraws consent (complaints stay anonymously), daily retention job. Feedback stays append-only except clearing the remark.
- **Security testing (vendor-side):** 1-hour soak at the 10× peak rate (2.8 complaints/s, 30,000 citizens, 150 workers): 10,163 filed, 10,158 resolved, 0 failed requests, inbox latency flat (22–26 ms), API memory +0.8 MB/min to watch ([results](../infra/load/RESULTS.md)). Report scaling on a year of one ULB's history (365,000 complaints) found the trend report taking 31 s for 30 days and 328 s for a year; rewritten to 0.6 s / 2.3 s with an equivalence test against the old query. Authenticated OWASP ZAP scan of the API (45,778 requests, measured coverage) and portal: two 500s, a missing static-asset CSP and an input-validation gap found and fixed ([DAST report](ops/DAST.md)); confirmation scan after the fixes: no 5xx, one accepted Medium (`style-src 'unsafe-inline'`). dependency audit clean (API, portal). Fixed: a wrong TOTP code while signed in logged admins out (401 → 400); portal forgot-password had no CAPTCHA although production requires it (hCaptcha added).
- **Backup and restore:** `infra/ops/backup.sh` (pg_dump, optional AES-256 encryption, checksum) and `restore-drill.sh` (fresh database, checksum, restore time, migrations, append-only triggers, complaint numbering consistency). Drill on a hot backup taken mid-soak: 30,045 users / ~2,800 complaints restored in 3 s; the drill catches a tampered sequence. Runs in CI.
- **Pilot and audit material:** [`docs/ops/PILOT_RUNBOOK.md`](ops/PILOT_RUNBOOK.md) (accounts and keys, master data, deploy, phone smoke test, go-live metrics, rollback), [`docs/ops/INCIDENT_RESPONSE.md`](ops/INCIDENT_RESPONSE.md) (CERT-In 6-hour reporting, containment, key rotation), [`docs/ops/AUDIT_PACK.md`](ops/AUDIT_PACK.md) (scope, accounts, data flows, permission matrix, STRIDE, evidence).

**Not done — needs people, devices or accounts the vendor does not have**
- First run on real low-end phones over 3G (both APKs come from the CI `android` job, which has not run: no PR yet).
- Google Play Console, Play Integrity and Firebase projects, hCaptcha, SMTP, hosting, Grievance Officer (see the runbook's account table).
- External pentest and the CERT-In-empanelled audit; MobSF on the release APKs.
- Legal review of the privacy notice text.
- The pilot itself.
