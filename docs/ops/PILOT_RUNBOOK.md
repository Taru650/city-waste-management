# Pilot runbook (one ULB)

Goal: run the system for real in one ULB for 4–6 weeks, prove the complaint loop works on the
phones and networks people actually have, then roll out district-wide. Owners: **ULB** (Sub Admin,
supervisors, workers), **State IT / NIC cell** (hosting, accounts), **vendor** (this codebase).

## 1. Accounts and keys (State IT, 2–4 weeks lead time)
| Needed | For | Where it goes |
|---|---|---|
| Google Play Console developer account (organisation) | publishing both apps; Play Integrity | — |
| Google Cloud project linked to each app in Play Console | Play Integrity | `PLAY_CLOUD_PROJECT_NUMBER` (app builds) |
| Service account with the Play Integrity API enabled | verifying app tokens | `PLAY_INTEGRITY_SERVICE_ACCOUNT_B64` |
| Release keystore (kept offline + in the vault) and its SHA-256 as Play reports it | signing; app identity check | CI secret → `android/key.properties`; `PLAY_INTEGRITY_CERT_SHA256` |
| Firebase project (Android apps for both packages) + service account | push notifications | `FIREBASE_*` (app builds); `FCM_SERVICE_ACCOUNT_B64` |
| hCaptcha account (site key + secret) | portal forgot-password | `HCAPTCHA_SITE_KEY` (portal), `CAPTCHA_SECRET` (API) |
| SMTP relay with TLS (NIC mail or equivalent) | password reset emails | `SMTP_URL`, `MAIL_FROM` |
| Domain + TLS certificates (API, portal) | HTTPS, certificate pinning | reverse proxy; SPKI pins → `CERT_PINS` (app builds) |
| MeitY-empanelled cloud or State Data Centre: managed PostgreSQL 16 + PostGIS with PITR, Redis, S3-compatible storage (versioning on), ClamAV | hosting | `DATABASE_URL`, `REDIS_URL`, `S3_*`, `CLAMAV_HOST` |
| Grievance Officer named by the ULB (DPDP Act) | privacy notice | `GRIEVANCE_OFFICER_*` |
| Map tiles allowed for production use (MapmyIndia / Bhuvan / self-hosted) | portal maps | `MAP_TILE_URL` |

Generate fresh `JWT_ACCESS_SECRET`, `JWT_MFA_SECRET` (≥ 32 chars, different), `PII_ENCRYPTION_KEY`,
`PII_HASH_KEY` (32 bytes base64) in the vault. **Back up `PII_ENCRYPTION_KEY` and `PII_HASH_KEY`
separately from database backups**: without them mobile numbers and emails cannot be recovered.

## 2. Master data (ULB, 1–2 weeks)
- LGD codes of the district and ULB (from lgdirectory.gov.in).
- Ward boundaries as GeoJSON (one file per ward, WGS84). Check each on the portal map preview. Wards
  without a boundary still work, but citizens must pick them by hand.
- Areas (groups of wards) and one supervisor per area.
- Staff list: Sub Admin(s), supervisors, workers with mobile numbers; who needs temporary access.
- Complaint types and SLA hours (defaults are seeded; adjust with the ULB).

## 3. Deploy
1. Production `.env` from `apps/api/.env.example` with `NODE_ENV=production`: the API refuses to
   start if anything security-relevant is missing (CAPTCHA, Play Integrity enforce + cert digest,
   ClamAV, SMTP with TLS, CORS origins, grievance officer).
2. Start one or more API replicas (`PROCESS_ROLE=api`) and at least one worker (`PROCESS_ROLE=worker`),
   behind the TLS/WAF proxy. The portal must be reachable only through that proxy.
3. Migrations run automatically (compose `migrate` service, before the API and workers; idempotent).
   Elsewhere: `node dist/database/run-migrations.js` from the API image, once per release, before
   the new API starts. Then the first Web Admin, once (enrols MFA and changes the password at first sign-in):
   `docker compose run --rm -e SEED_ADMIN_MOBILE=… -e SEED_ADMIN_EMAIL=… -e SEED_ADMIN_PASSWORD=… migrate node dist/database/seed.js`.
   The image has no npm/ts-node: `npm run seed` / `migration:run` are for development checkouts only.
   Break-glass if the only Web Admin loses their authenticator and recovery codes (audited):
   `docker compose run --rm -e RESET_ADMIN_MFA_MOBILE=… migrate node dist/database/seed.js`.
4. Web Admin → District Admin → Sub Admin (each with authenticator MFA); Sub Admin enters wards,
   areas, staff (temporary passwords handed over in person).
5. Build the apps in CI with the production `--dart-define`s; publish to an internal testing track
   first (closed group: the ULB's staff + 20 volunteer citizens).
6. Set `PLAY_INTEGRITY_MODE=monitor` for the first week of closed testing (verdicts recorded, nobody
   blocked; check how many phones fail), then `enforce` before public launch — production requires it.

## 4. Smoke test before opening (30 minutes, on real phones)
- [ ] Citizen: register on a low-end Android phone over mobile data; accept the notice; file a
      complaint with a photo from inside a ward; it routes to the right supervisor.
- [ ] Supervisor (Staff app): sees it, assigns a worker; push notification arrives.
- [ ] Worker: navigate, start with photo, resolve with photo — once with airplane mode on, then off
      (the queued proof uploads by itself).
- [ ] Citizen: sees before/after photos, rates 2 stars with reopen → complaint reopens.
- [ ] Sub Admin (portal): dashboard figures match; export to Excel; event zone created and cancelled.
- [ ] Citizen: My data shows the complaint; delete account → signed out, can register again.
- [ ] Restore drill on the production backup (`infra/ops/restore-drill.sh`) — and record the time.

## 5. Go-live and the first weeks
- Announce through ward councillors and SHGs; QR codes on garbage vehicles linking to the Play listing.
- Daily for the first 2 weeks: complaints received/resolved, SLA breaches, reopen rate, failed
  uploads (outbox errors reported by staff), Play Integrity failure rate, API error rate.
- Weekly review with the Sub Admin: workers with many open tasks, wards with no boundary, rejected
  complaints and why.
- Pilot success: ≥ 80 % complaints resolved within SLA, reopen rate < 15 %, < 1 % upload failures,
  no P1 incident. Then district rollout.

## 6. Rollback
- App problem: halt the staged Play rollout; previous app versions keep working (the API is
  backward compatible within a release line).
- API problem: redeploy the previous image; migrations only add, so the previous version runs on the
  new schema. Never restore a database backup to fix an application bug — restore only for data loss.
