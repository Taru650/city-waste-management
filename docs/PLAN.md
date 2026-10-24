# City Cleanliness Grievance System — Plan (rev 2)

## Context
The repo `city-waste-management` is empty. We're building it from scratch, using the uploaded SRS (Citizen Registration, Complaint, Resolution) and the 6-tier role diagram:
Web Admin → District Admin → Sub Admin (Nagar Nigam / Parishad / Panchayat) → Area Supervisor → Sanitation Worker, with Citizen → Supervisor (complaint) and Supervisor ⇢ Citizen (feedback loop).

Goal: citizens report waste or cleanliness problems (garbage, water logging, drains and so on) **at any location, in any ward or ULB**, with photo or video taken in the app. Each complaint is routed automatically to that location's area supervisor, assigned to a field worker, and resolved with geotagged proof taken in the app. The citizen then rates the fix. Sub-admins and district admins get pendency, ageing, disposal-time and quality analytics.

### Decisions taken (rev 2)
- **Stack:** Flutter (mobile) · Next.js (web) · NestJS (API) · PostgreSQL + PostGIS (DB).
- **No OTP at registration in v1.** OTP is planned for a later version.
- **Full status state machine** (§3) replaces Pending / WIP / Resolved.
- **Complaint ID built from standard government codes** (§3.1).
- **Feedback:** 1–5 rating, remark, optional reopen.
- **Camera only:** photos and videos come from the in-app camera; gallery and file pickers are blocked.
- **Complaint location is independent of the citizen's registered ward.** ULB and ward come from the complaint's GPS location or are chosen by the citizen.

## 0. Remaining SRS gaps and fixes
| Gap | Fix |
|---|---|
| No complaint SLA or escalation | Each complaint type gets SLA hours. Breaches escalate (§3) |
| Lat/long "from photo" | Never read EXIF. GPS is taken from the device at the moment of capture, with accuracy, and mock-location detection |
| Father/Husband name | DPDP Act 2023 data-minimisation risk. Keep it optional unless there's a legal reason |
| No OTP means unverified mobile and email | Mobile number must be unique, plus CAPTCHA, device and IP rate limits, and max 10 complaints per citizen per day. Password reset limits in §5 |
| Ward polygons needed for auto-routing | Collect ward boundary GeoJSON/KML from each ULB in Phase 0. Until it exists, routing uses the ward the citizen picks |

## 1. Technology stack
| Layer | Choice | Notes |
|---|---|---|
| Mobile | **Flutter**: two apps from one codebase. *Citizen* app, and *Staff* app for Supervisor + Worker. Shared code in `packages/flutter_core` | Android-first. Uses the `camera` package with a custom capture screen. `image_picker` / `file_picker` are **not** used anywhere |
| Web portal | **Next.js (App Router, TypeScript)**, Ant Design, Apache ECharts, Leaflet + OSM/MapmyIndia tiles | Admin and supervisor web. Auth kept in httpOnly cookies through Next.js middleware |
| Backend API | **NestJS (TypeScript)**, REST + OpenAPI, Prisma or TypeORM | Guards for RBAC + jurisdiction scope. DTO types generated from OpenAPI for Next.js |
| DB | **PostgreSQL 16 + PostGIS** | Ward polygons, point-in-polygon routing, geofence checks, duplicate radius, analytics |
| Cache/queue | Redis + BullMQ | Rate limits, SLA timers, media jobs, notifications |
| Media storage | S3-compatible (MinIO / S3 Mumbai / MeitY cloud) | Media is never stored in the DB. The DB holds only keys and metadata |
| Media processing | FFmpeg + libvips worker containers | |
| Notifications | FCM push (SMS added later, together with OTP) | |
| Deploy | Docker. Compose for the pilot, Kubernetes for statewide scale. Nginx + WAF, GitHub Actions CI | MeitY-empanelled cloud or State Data Centre |

Monorepo layout: `apps/api` (NestJS), `apps/web` (Next.js), `apps/mobile_citizen`, `apps/mobile_staff`, `packages/flutter_core`, `packages/api-types`, `infra/`, `docs/`.

## 2. Data model (core tables)
- `districts` (lgd_code, census2011_code?, name), `ulbs` (lgd_code, type: NAGAR_NIGAM / NAGAR_PARISHAD / NAGAR_PANCHAYAT, district_id, `geom` boundary), `wards` (ulb_id, number, `geom` polygon), `areas` (group of wards → supervisor)
- `users` (role, mobile unique, email, password_hash Argon2id, mfa_secret, status), `user_scopes` (user_id → district / ulb / ward / area). **Every query is filtered by scope**
- `citizens` (user_id, home district / ulb / ward: profile only, **not used for complaint routing**; name, guardian_name?)
- `complaint_types` (code, name_en, name_hi, sla_hours, active): Garbage heap, Water logging, Drain blockage, Dead animal, Public toilet, Burning garbage, Sweeping not done, Other
- `complaints` (id UUID PK, **complaint_no unique**, citizen_id, district_id, ulb_id, ward_id, area_id, ward_source: GPS / MANUAL, ward_mismatch bool, type_id, landmark ≤50, description ≤250, `location` point, gps_accuracy, status, supervisor_id, worker_id, sla_due_at, created_at, resolved_at, closed_at, duplicate_of)
- `complaint_seq` (ulb_id, year, last_value): per-ULB yearly counter for complaint numbers
- `complaint_media` (complaint_id, stage: COMPLAINT / WIP / RESOLUTION, kind, object_key, thumb_key, bytes, duration, location, gps_accuracy, captured_at, uploaded_at, sha256, capture_sig, is_mock_location)
- `complaint_events`: append-only status history (from, to, actor, remark, location, at). Source for all time-taken analytics and the audit trail
- `feedback` (complaint_id unique, rating 1–5, remark ≤250, reopen_requested bool, created_at)
- `audit_logs`, `refresh_tokens`, `password_resets`, `notifications`

## 3. Complaint lifecycle
```
PENDING ─auto-route─▶ ASSIGNED (to supervisor) ─assign worker─▶ ASSIGNED (worker set)
   ─worker starts (camera photo)─▶ WORK_IN_PROGRESS ─camera photo/video + remark─▶ RESOLVED
Supervisor may resolve directly from ASSIGNED.
Supervisor may mark REJECTED (invalid, reason required) or DUPLICATE (linked to the original) from PENDING/ASSIGNED.
RESOLVED ─citizen rating ≥3, or no feedback in 7 days─▶ CLOSED
RESOLVED ─rating ≤2 with "reopen" ticked, within 7 days─▶ REOPENED ─▶ ASSIGNED (same supervisor, flagged)
```
- Statuses: `PENDING, ASSIGNED, WORK_IN_PROGRESS, RESOLVED, REJECTED, DUPLICATE, REOPENED, CLOSED`. Transitions are enforced in one `ComplaintStateMachine` service. Each transition writes `complaint_events` and notifies the citizen.
- Reopen limit: 2 times. After that it escalates to the Sub Admin.
- **Duplicates:** same type within 50 m within 48 h → the supervisor sees candidates to merge. Citizens on a merged complaint are all notified.
- **Proof checks:** the resolution photo must be taken in-app, within 100 m of the complaint (PostGIS `ST_DWithin`), and after assignment. If not, it's still allowed but flagged in the quality report.
- **SLA:** a BullMQ delayed job fires at `sla_due_at` → notify the supervisor. At 2× SLA → escalate to the Sub Admin.

### 3.1 Complaint number (unique, standard-code based)
Use the **LGD (Local Government Directory, MoPR) codes** for district and ULB. LGD is the maintained national standard. Census 2011 codes miss districts and ULBs created after 2011, so they are stored only as a reference column.

Format: `{DistrictLGD:4}{ULB_LGD:6}{YY}{Seq:6}`, numeric only (works for SMS and helpline). Shown with dashes:
`0446-800123-26-000457` → district 0446, ULB 800123, 2026, 457th complaint of that ULB this year.
- The ULB in the number is the **complaint location's ULB**, not the citizen's.
- Sequence comes from `UPDATE complaint_seq SET last_value = last_value + 1 WHERE ulb_id=$1 AND year=$2 RETURNING last_value`, inside the complaint-insert transaction. That is atomic, with no gaps from races. A `UNIQUE(complaint_no)` constraint backs it up.
- Ward is left out on purpose: wards are re-delimited and the number must never change.
- Internal PK stays a UUID. The API never takes sequential numbers as an access key without a scope check.

### 3.2 Complaint location (any ward / any ULB)
1. The citizen captures the photo or video in the camera screen. GPS is captured at the same moment.
2. The API resolves `ST_Contains(ward.geom, point)` → ward → ULB → district, and the form is pre-filled with these.
3. The citizen can change District → ULB → Ward in dependent dropdowns (e.g. GPS inaccurate, or no polygon data). This sets `ward_source=MANUAL`. If the chosen ward is more than 500 m from the GPS point, `ward_mismatch=true` and the supervisor sees a warning.
4. The registered home ward is **never** used as a default.
5. Routing: ward → area → supervisor. If there is no supervisor, the complaint goes to the ULB Sub Admin queue.

## 4. Media: camera only, then compression
**Capture rules (Citizen and Staff apps):**
- Custom in-app camera screen (`camera` plugin). No gallery, file picker or share-intent import. App permissions include camera, location and microphone (for video) only; no storage-read permission.
- Capture is blocked unless GPS has a fix with accuracy ≤ 50 m and the location is not mocked (`isMocked` from the `geolocator` package). A rooted or tampered device fails the Play Integrity check, and its media is flagged.
- At capture, the app records timestamp, lat/long and accuracy, computes sha256 over the compressed file, and signs `{sha256, ts, lat, lng}` with a per-install key registered at login. The server rejects media whose signature fails, and media captured more than 24 h before upload (the offline window for workers). This makes uploading files from outside the app impractical, though not impossible on a rooted device, which is why flags exist.
- Optional timestamp and location watermark burned into the photo, for evidence value.
- Web portal: **no media upload at all.** A supervisor on the web can assign, reject, merge or resolve with remark only; a resolution that needs photos is done in the Staff app.

**Compression (visually lossless):**
- Photos: on the device, long edge 1920 px, JPEG/WebP quality 80. A typical 4–8 MB photo becomes 250–500 KB. The server re-encodes with libvips, makes a 320 px thumbnail and strips EXIF from served copies (GPS is kept in the DB).
- Video: limited to 30 s at capture. Compressed on the device to 720p H.264 (`video_compress`). The server's FFmpeg pass is `-c:v libx264 -crf 26 -preset slow -vf scale=-2:720 -c:a aac -b:a 64k -movflags +faststart`. 30 s ends up at ~4 MB (raw ~60 MB).
- Upload: pre-signed PUT straight to storage, resumable, magic-byte check, size cap, ClamAV, sha256 dedupe. Limits: 5 photos + 1 video per stage.
- Lifecycle: after 12 months, media moves to cold storage. Thumbnails stay hot.
- Estimate: 1,000 complaints/day ≈ 3 GB/day ≈ 1.1 TB/year (≈10 TB uncompressed).

## 5. Security
- **Citizen registration (v1, no OTP):** District → ULB → Ward, name, guardian name (optional), mobile (unique, format-validated), email, password. CAPTCHA on registration and login, and rate limits per IP and device. Status is `UNVERIFIED_MOBILE` so OTP can be added later without a schema change.
- **Staff accounts** are created by the role above, with a forced password change on first login. **Mandatory TOTP MFA for Sub Admin, District Admin and Web Admin.**
- **Passwords:** Argon2id, minimum 8 characters, checked against a breached-password list. Backoff and lockout after 5 failures.
- **Password reset (v1, no SMS):**
  - Citizen: reset link to the registered email (single-use token, hashed in the DB, 15 min expiry). Fallback: the ULB Sub Admin's helpdesk resets it to a temporary password with forced change. Either way, all sessions are revoked and the response is identical whether or not the account exists.
  - Staff: reset by the role above, or self-service by email + TOTP.
  - v2: SMS OTP reset, once DLT registration is done.
- **Sessions:** 15-min JWT access token + rotating refresh token (reuse → revoke the whole family). Mobile stores tokens in `flutter_secure_storage`; web uses httpOnly, Secure, SameSite cookies + CSRF token.
- **Authorization:** RBAC + jurisdiction ABAC, in a NestJS guard **and** the repository layer. A supervisor can never read another area's complaint by changing an ID (IDOR is the top real risk). A citizen sees only their own complaints.
- **Transport and data:** TLS 1.2+, HSTS, certificate pinning in the apps, PII (mobile, email) encrypted at rest, media served by signed URLs valid 5 min.
- **App hardening:** Play Integrity, root detection in the Staff app, R8 obfuscation, no secrets in the APK.
- **Platform:** WAF, Nginx + API rate limits, CSP and security headers, OWASP ASVS L2 / MASVS, Trivy / npm audit in CI, secrets in a vault, immutable admin audit log.
- **Compliance:** CERT-In 2022 directions (logs kept 180 days in India, incidents reported within 6 h), DPDP Act 2023 (consent, purpose, deletion), GIGW. **A CERT-In-empanelled audit is required before go-live.**
- **Backups:** PostgreSQL PITR (WAL archiving), storage versioning, quarterly restore drill.

## 6. Peak-event handling (festivals, melas, monsoon)
- **Event Zones:** a polygon, a date range, temporary staff and a tighter SLA. Complaints inside the zone route there and get their own dashboard.
- Stateless API (scale horizontally), media goes direct to storage, transcoding is queued, and the worker app works offline and syncs later. k6 load test at 10× normal daily volume in 1 hour.

## 7. Role features and reports
- **Web Admin:** districts and ULBs (with LGD codes), complaint types and SLAs, district admins, platform audit.
- **District Admin:** ULBs and sub-admins; drilldown over all ULBs.
- **Sub Admin:** wards and areas (GeoJSON/KML upload), supervisors and workers, allotments, reports.
- **Supervisor (web + Staff app):** inbox, assign or reassign, self-resolve (photos in the app only), reject or duplicate, map.
- **Worker (Staff app):** tasks, navigate (Google Maps intent), start with a camera photo, resolve with camera photo/video + remark, offline mode, Hindi UI.
- **Citizen (app):** register, complain anywhere, track by complaint number, see before/after photos, rate 1–5 + remark + reopen.

**Reports** (filter by district / ULB / ward / area / type / date range; export to Excel and PDF):
- Received / Resolved / Pending / Rejected / Duplicate counts
- Pendency ageing buckets (0–1, 1–3, 3–7, 7–15, >15 days), date-wise pendency trend
- Disposal time: average / median / P90, assignment lag and field time (from `complaint_events`)
- SLA compliance %, escalations
- Quality: average rating, % satisfied, reopen rate, geofence-failed or flagged proofs, ward-mismatch rate
- Complaint-type mix, hotspot heatmap, hour and weekday patterns
- Supervisor and worker performance
- Cross-ward complaints: complaints filed by citizens outside their home ward

Implementation: PostgreSQL materialized views refreshed every 15 min, plus live counters.

## 8. Delivery phases (≈ 22 weeks)
1. **Weeks 0–2:** SRS sign-off, Hindi and English wireframes, collect LGD codes and ward GeoJSON per ULB.
2. **Weeks 3–12, MVP:** auth and reset, masters with LGD, complaint lifecycle and numbering, camera capture + media pipeline, both apps, supervisor and sub-admin web, basic dashboard.
3. **Weeks 13–18:** SLA and escalation, feedback and reopen, duplicates, full analytics and exports, event zones, offline sync.
4. **Weeks 19–22:** CERT-In audit, load test, pilot in one ULB, district rollout.
5. **v2:** SMS OTP at registration and for reset (needs DLT), WhatsApp notifications, iOS release.

Team: 1 BA/PM, 2 Flutter, 2 backend, 1 Next.js, 1 QA, 0.5 DevOps.

## 9. Verification
- Jest unit and e2e tests (API against dockerised PostGIS + MinIO), flutter_test, Playwright for Next.js.
- State machine: tests for every allowed and forbidden transition.
- Complaint number: concurrency test (200 parallel inserts in one ULB → no duplicates, no gaps).
- Location: point-in-polygon tests, ward override, mismatch flag, complaint outside the home ward routes to the correct supervisor.
- Camera only: a media upload without a valid capture signature is rejected; a mocked location blocks capture.
- Scope isolation: every endpoint tested with an out-of-jurisdiction user → 403/404.
- Media: output size and resolution checks, SSIM ≥ 0.95.
- k6 load test, OWASP ZAP in CI, MobSF on the APKs, CERT-In audit, UAT on low-end Android over 3G.

## First implementation step after approval
On branch `claude/dreamy-archimedes-ghq9vt`: scaffold the monorepo, write `docker-compose` (PostGIS, Redis, MinIO), the NestJS API skeleton with the schema from §2, the complaint numbering and state machine with tests, and the Next.js and Flutter app shells.
