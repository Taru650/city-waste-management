# API reference (`/api/v1`)

One REST API for the website and the mobile apps. The request schemas in `src/validation/*.ts` are the source of
truth for field names, lengths and limits; this page is the map.

## Conventions

* **Base URL:** `http://localhost:3000/api/v1` locally. JSON in and out (`Content-Type: application/json`), except file
  uploads and downloads.
* **Strict input:** unknown fields are rejected with `400`. Bodies are limited to 1 MB (photos and videos use their own
  endpoints).
* **Errors:** always `{ "statusCode": 400, "message": "..." or ["field: problem", ...] }`, sometimes with `"code"`.
  `401` not signed in or session ended; `403` not allowed (`code: CONSENT_REQUIRED` for a citizen who has not accepted the
  current privacy notice); `404` not found **or not yours** (the API does not reveal other people's ids);
  `409` conflicting state; `422` a rule was not met; `429` rate limit (`Retry-After` header); `503` database
  unavailable.
* **Lists:** `GET` lists accept `page` (default 1) and `pageSize` (default 20, max 100) and answer
  `{ "total": 123, "items": [...] }`.
* **Dates:** UTC ISO 8601 in answers. Report ranges are `YYYY-MM-DD` and are interpreted in Indian Standard Time.
* **Complaint numbers:** `DDDD-UUUUUU-YY-SSSSSS` (district LGD, ULB LGD, year, running number per ULB and year).
* **Action endpoints** (assign, start, resolve, reject, duplicate, feedback, upload-url, reset-password) answer `201`.

## Authentication

| Client | How |
|---|---|
| App | `POST /auth/login` → `{ status, accessToken, refreshToken, expiresIn, refreshExpiresIn, tokenType }`. Send `Authorization: Bearer <accessToken>`. When it answers `401`, `POST /auth/refresh` with `{ "refreshToken": "..." }` and use the new pair (the old refresh token is now dead). |
| Website | Add `"session": "cookie"` to login / register / change-password. The answer has no tokens; `httpOnly` `SameSite=Strict` cookies `cwm_at` and `cwm_rt` are set. Every state-changing call must send `x-cwm-csrf: 1` from the same origin. `POST /auth/refresh` with an empty body renews from the cookie. |

Details that matter: access tokens last 15 minutes (`ACCESS_TOKEN_TTL_SECONDS`); refresh tokens are single use and
re-using one ends the session; 5 wrong passwords lock an account for 15 minutes; a staff member created by an admin has
`mustChangePassword: true` and can only call `GET /auth/me`, `POST /auth/change-password` and logout until they change
it; **every request re-checks the account, the password version and the session in the database**.

### Auth endpoints

| Method and path | Who | Purpose |
|---|---|---|
| `POST /auth/register` | public | Citizen sign-up (home ward, name, mobile, e-mail, password, accepted notice version) |
| `POST /auth/login` | public | Sign in with mobile number or e-mail and password |
| `POST /auth/refresh` | public | Renew the session (see above) |
| `POST /auth/logout` | public | End this session (body `refreshToken`, or the cookie) |
| `POST /auth/logout-all` | signed in | End every session of the user |
| `GET /auth/me` | signed in | The current user (role, name, jurisdiction, `mustChangePassword`, `consentRequired`) |
| `PATCH /auth/me/preferences` | signed in | `preferredLanguage`: `hi` or `en` |
| `POST /auth/change-password` | signed in | `currentPassword`, `newPassword`; ends all other sessions and returns a fresh session |
| `POST /auth/forgot-password` | public | Always `202`, whether or not the account exists; mails a 15-minute single-use link |
| `POST /auth/reset-password` | public | `token`, `newPassword`; ends every session |
| `POST /attestation/challenge` | public | Compatibility for the apps: always `{ "enabled": false }` (no Play Integrity here) |

Passwords: at least 8 characters with letters and numbers, not the user's own mobile number.

## Roles

`WEB_ADMIN` > `DISTRICT_ADMIN` > `SUB_ADMIN` > `SUPERVISOR` > `WORKER`, and `CITIZEN`. Each role sees only its
jurisdiction: district, ULB, area, own tasks, or own complaints. A request outside it answers `404` (or `403` when the
role itself is not allowed).

## Masters (geography and types)

| Method and path | Who | Purpose |
|---|---|---|
| `GET /masters/districts` | public | Districts |
| `GET /masters/districts/{id}/ulbs` | public | ULBs of a district |
| `GET /masters/ulbs/{id}/wards` | public | Wards of a ULB (`number`, `name`, `hasBoundary`, `areaId`) |
| `GET /masters/complaint-types` | public | Active complaint types (English and Hindi names, deadline hours) |
| `GET /masters/locate?lat=&lng=` | signed in | Which ward, ULB and district contain this GPS point |
| `GET /masters/ulbs/{id}/boundaries` | admins, supervisor | Ward boundaries as GeoJSON |
| `GET /masters/ulbs/{id}/areas` | admins | Areas and their supervisors |
| `POST /masters/districts`, `PATCH /masters/complaint-types/{id}`, `GET /masters/complaint-types/all` | Web Admin | Create districts; change deadlines and activation |
| `POST /masters/ulbs` | Web, District Admin | Create a ULB |
| `POST /masters/wards`, `PATCH /masters/wards/{id}` | admins | Create or change a ward and its GeoJSON boundary (overlap over 100 m² with another ward is refused) |
| `POST /masters/areas`, `PATCH /masters/areas/{id}` | admins | Group wards under a supervisor |

## Users

| Method and path | Who | Purpose |
|---|---|---|
| `GET /users?role=` | admins | Staff in the caller's jurisdiction |
| `POST /users` | admins | Create staff (each role creates the role directly below). Answer includes a one-time `tempPassword` |
| `PATCH /users/{id}/status` | admins | `ACTIVE` or `DISABLED` (sessions end at once) |
| `POST /users/{id}/reset-password` | admins | New temporary password; all sessions end |
| `GET /users/workers` | Sub Admin, Supervisor | Workers available to assign, with open task counts |

## Complaints

| Method and path | Who | Purpose |
|---|---|---|
| `POST /complaints` | Citizen | File one: `typeId`, `lat`, `lng`, `description` (5-250), optional `landmark`, `wardId`, 1 to 6 verified `mediaIds`. Routed by GPS to the ward, area and supervisor; anywhere in any ULB is allowed |
| `GET /complaints` | any | List within the caller's scope. Filters: `status`, `ulbId`, `wardId`, `typeId`, `eventZoneId`, `from`, `to`, `escalated`, `open`, `overdue` |
| `GET /complaints/{id}` | any (in scope) | Details, history, feedback |
| `GET /complaints/{id}/media` | any (in scope) | Photos and videos with 5-minute signed links |
| `GET /complaints/track/{complaintNo}` | any (in scope) | Find a complaint by its number (citizens: only their own) |
| `POST /complaints/{id}/assign` | Sub Admin, Supervisor | `workerId` (and for Sub Admins optionally `supervisorId`), `remark` |
| `POST /complaints/{id}/start` | Worker, Supervisor, Sub Admin | Start work, with camera proof `mediaIds` |
| `POST /complaints/{id}/resolve` | Worker, Supervisor, Sub Admin | `remark`, proof `mediaIds`, `location` |
| `POST /complaints/{id}/reject` | Supervisor, Sub Admin | `reason` |
| `GET /complaints/{id}/duplicate-candidates`, `POST .../duplicate` | Supervisor, Sub Admin | Same type within 50 m and 48 hours; merge with `duplicateOfId` |
| `POST /complaints/{id}/feedback` | Citizen | `rating` 1 to 5, `remark`, `reopen` (only with 1 or 2) |

Status flow: `PENDING` → `ASSIGNED` → `WORK_IN_PROGRESS` → `RESOLVED` → `CLOSED`, with `REJECTED`, `DUPLICATE` and
`REOPENED` (limit: two reopenings). `RESOLVED` closes by itself after 7 days without a rating. Every change is
checked against one state machine and written to an append-only history. Deadlines (SLA) are per complaint type;
a missed deadline escalates after twice the time.

## Camera evidence (photos and videos)

Evidence comes only from the in-app camera and is verified:

1. `POST /devices` registers the phone's signing key (EC P-256 public key, base64 SPKI). `GET /devices`, `DELETE /devices/{id}`.
2. `POST /media/upload-url` declares one file: `deviceId`, `kind` (`PHOTO` or `VIDEO`), `contentType`, exact `bytes`,
   `sha256`. Answer: `{ mediaId, uploadUrl, method: "PUT", headers, expiresInSeconds }`.
3. `PUT {uploadUrl}` sends the bytes with exactly the declared type and size. **The address itself is the credential**
   (signed, tied to this one upload, expires with the upload window); no `Authorization` header is needed.
4. `POST /media/{id}/confirm` with `manifest` and `signature`: the capture manifest (time, GPS, checksum, device) signed
   by the phone's key. The server checks the signature, age (at most 24 hours), GPS accuracy, mock-location flag,
   checksum, real file type and malware, then re-encodes the photo (videos in the background).
5. Use the `mediaId` when filing, starting or resolving. `GET /media/{id}` (owner) shows the processing status.
   `GET /media/{id}/file?...` serves a file through a signed 5-minute link (Range requests supported).

Limits: JPEG or WebP photos up to 8 MB, MP4 video up to 60 MB (30 seconds), 6 files per action, daily and pending limits per user.

## Notifications

`GET /notifications` (`unread=true`, paging), `GET /notifications/unread-count`, `POST /notifications/{id}/read`,
`POST /notifications/read-all`, `POST /notifications/push-tokens` and `DELETE /notifications/push-tokens` (Firebase device
tokens). Texts are stored in Hindi and English; the user's `preferredLanguage` decides which the apps show.

## Reports (Web Admin, District Admin, Sub Admin, Supervisor)

All accept `from`, `to` (`YYYY-MM-DD`, India time; default the last 30 days), `districtId`, `ulbId`, `wardId`, `typeId`,
`eventZoneId`, and are always limited to the caller's jurisdiction.

| Path | Answer |
|---|---|
| `GET /reports/summary` | Received, resolved, pending, rejected, duplicate, overdue, escalated; disposal time (average, median, P90); SLA compliance; rating, satisfaction, reopen rate, proofs far from the site |
| `GET /reports/trend` | Per day: received, resolved, pending at day end |
| `GET /reports/ageing?groupBy=` | Open complaints by age bucket (under 1 day, 1-3, 3-7, 7-15, over 15), grouped by district, ULB, ward, type or supervisor |
| `GET /reports/breakdown?by=` | Performance table by `district`, `ulb`, `ward`, `type`, `supervisor` or `worker` |
| `GET /reports/hotspots` | Clustered complaint locations for the map |
| `GET /reports/export?report=&format=` | Excel (`xlsx`) or `csv` of `complaints`, `breakdown`, `ageing` or `trend`; at most 50,000 rows; one export per user at a time |

## Event zones

`GET /event-zones` (`when=current|upcoming|past|all`, `ulbId`), `GET /event-zones/{id}` (with statistics) for admins and
supervisors; `POST /event-zones` and `PATCH /event-zones/{id}` for admins (`name`, GeoJSON `boundary`, `startsAt`,
`endsAt`, optional zone `supervisorId` and `slaHours`; `active:false` cancels). Complaints filed inside a running zone go
to its supervisor with the shorter deadline; when it ends, open complaints go back to the area supervisors.

## Privacy (DPDP Act, citizens)

`GET /privacy/notice` (public, English and Hindi, with the grievance officer), `POST /privacy/consent`,
`GET /privacy/my-data` (full export), `PATCH /privacy/profile` (correct name, guardian name, e-mail),
`POST /privacy/erasure` (`password`; identity is erased, complaint statistics stay anonymous).

## Health

`GET /health` (process is up) and `GET /health/ready` (database answers, `503` otherwise): for load balancers.

## CORS

Browsers on another website can use the API with a bearer token only if their origin is listed in `CORS_ORIGINS`.
Credentials (cookies) are never allowed cross-origin. Mobile apps are not browsers and need nothing.
