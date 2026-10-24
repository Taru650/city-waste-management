# API (`@cwm/api`)

NestJS 11 · PostgreSQL 16 + PostGIS 3 · TypeORM (migrations and pooling; queries are explicit SQL).

One REST API at `/api/v1` serves the Citizen app, the Staff app and the web portal.
OpenAPI docs: `/api/docs` (disabled in production).

## Run locally
```bash
cp .env.example .env                    # fill in secrets: openssl rand -base64 48 / 32
npm ci
npm run migration:run
SEED_ADMIN_PASSWORD='…' npm run seed    # first Web Admin; enrols TOTP at first login
npm run start:dev
```
Or with Docker: `POSTGRES_PASSWORD=… docker compose -f ../../infra/docker-compose.yml up`.

## Tests
Needs a PostgreSQL with PostGIS reachable at `DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/cwm_test`),
`ffmpeg`/`ffprobe` on PATH, and an S3 endpoint at `S3_ENDPOINT` (default `http://127.0.0.1:5055`). If nothing listens there,
the test setup starts `moto_server` (`pip install "moto[server]"`, or set `MOTO_SERVER_BIN`).
The test database is dropped and rebuilt from migrations on every run (it refuses names not ending in `_test`).
```bash
npm test               # everything (unit + integration + security)
npm run test:unit
npm run test:e2e
npm run test:security  # OWASP-oriented suite
npm run lint && npm run typecheck && npm run audit:prod
```

## Endpoints (summary)
| Area | Routes |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/mfa/{enroll,activate,verify}`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `/auth/change-password`, `/auth/forgot-password`, `/auth/reset-password`, `GET /auth/me` |
| Masters | `GET /masters/districts`, `/masters/districts/:id/ulbs`, `/masters/ulbs/:id/wards`, `/masters/complaint-types`, `/masters/locate?lat&lng`; admin `POST/PATCH` for districts, ULBs, wards (GeoJSON), areas, complaint-type SLAs |
| Users | `POST /users` (staff, one level down), `GET /users`, `PATCH /users/:id/status`, `POST /users/:id/reset-password` |
| Complaints | `POST /complaints`, `GET /complaints`, `GET /complaints/:id`, `GET /complaints/track/:no`, `GET /complaints/:id/media`, `GET /complaints/:id/duplicate-candidates`, `POST /complaints/:id/{assign,start,resolve,reject,duplicate,feedback}` |
| Media | `POST /devices`, `GET /devices`, `DELETE /devices/:id`, `POST /media/upload-url`, `POST /media/:id/confirm`, `GET /media/:id` — see [`docs/MEDIA_CAPTURE_CONTRACT.md`](../../docs/MEDIA_CAPTURE_CONTRACT.md) |

## Decisions worth knowing
- **Jurisdiction on the user row.** Each staff user has exactly one `district_id`/`ulb_id`; supervisors own areas via `areas.supervisor_id`. Simpler and safer than a many-to-many scope table; revisit if one officer must cover several ULBs.
- **Complaint number** `DDDD-UUUUUU-YY-NNNNNN` = district LGD (4) + ULB LGD (6) + year (IST) + per-ULB yearly sequence, generated atomically in the insert transaction.
- **Complaint location decides the ward.** The citizen's home ward is profile data only.
- **Media never passes through the API on upload.** Apps PUT to pre-signed S3 URLs; the API verifies, scans and re-encodes afterwards. Video transcoding runs in an in-process queue for now (resumed on restart); it moves to BullMQ workers in M4.
