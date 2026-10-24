# Delivery milestones

A milestone is done only when its features **and** their tests (unit + integration +
security) pass in CI. The next milestone does not start until then.

| # | Milestone | Status |
|---|-----------|--------|
| M1 | API foundation, auth, sessions, staff hierarchy | ✅ Done |
| M2 | Masters (LGD codes, ward polygons, areas) and complaint lifecycle | ✅ Done |
| M3 | Camera-only media pipeline (capture signature, upload, compression) | ⏭ Next |
| M4 | SLA timers, escalation, auto-close job, push notifications | Planned |
| M5 | Reports and analytics (pendency, ageing, disposal time, quality, exports) | Planned |
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

## M3 — Camera-only media pipeline (next)
- Device key registration at login (per-install keypair in Android Keystore).
- `POST /complaints/:id/media/upload-url` → pre-signed PUT to S3/MinIO; `POST .../media/confirm` with signed capture manifest `{sha256, capturedAt, lat, lng, accuracy, isMock}`.
- Server: verify signature, capture time ≤ 24 h, sha256 match, magic bytes, size caps (5 photos + 1 × 30 s video per stage), ClamAV scan, EXIF strip, libvips/FFmpeg re-encode, thumbnails.
- Photo mandatory for START and RESOLVE by workers; complaint creation requires ≥ 1 photo or video.
- Signed GET URLs (5 min) for viewing.
- **Tests:** forged/missing signature rejected, stale capture rejected, MIME spoofing rejected, oversize rejected, cross-scope media access 404, compression ratio and SSIM ≥ 0.95.

## M4 — SLA, escalation, notifications
- BullMQ + Redis: SLA breach → supervisor; 2× SLA → Sub Admin; nightly auto-close job.
- FCM push on every status change; in-app notification list.
- **Tests:** timers fire, idempotent jobs, no notifications leak other citizens' data.

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
