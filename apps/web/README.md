# Web portal (`@cwm/web`)

Next.js 16 (App Router) · antd 6 · ECharts · Leaflet. For Web Admins, District Admins, Sub Admins
(Nagar Nigam / Parishad / Panchayat) and Area Supervisors. Workers and citizens use the mobile apps.

## How it talks to the API
The browser only talks to this portal. Server-side route handlers (`src/app/bff/*`) call the
NestJS API and keep the access/refresh tokens in httpOnly cookies, so page JavaScript never sees
a token. `src/proxy.ts` sets a per-request CSP nonce, refreshes expiring sessions and redirects
signed-out visitors to `/login`. `/bff/api/*` forwards everything else to the same API the
mobile apps use, minus token-issuing and mobile-only endpoints.

## Run locally
```bash
cp .env.example .env     # API_URL must point at the running API
npm ci
npm run dev              # http://localhost:3001
```

## Tests
```bash
npm run lint && npm run typecheck
npm test                 # unit tests (vitest): CSRF, gateway rules, session refresh, redirects, GeoJSON
npm --prefix ../api run build && npm run build
npm run test:e2e         # Playwright: real browser + real API + PostgreSQL/PostGIS + Redis + S3 (moto)
```
The e2e run creates and seeds its own database (`cwm_e2e_test`), starts moto and Redis if
needed, and boots the API and the production portal build on ports 3100 and 3200.

## Configuration
| Variable | Purpose |
|---|---|
| `API_URL` | Internal API base URL (server-side only) |
| `PORTAL_ORIGIN` | Public origin of the portal (CSRF origin check, HTTPS upgrades) |
| `MEDIA_ORIGINS` | Public S3/MinIO origin(s) the browser may load evidence from (CSP) |
| `MAP_TILE_URL` | Map tiles (use MapmyIndia/Bhuvan or self-hosted tiles in production) |
| `COOKIE_SECURE` | `false` only for plain-HTTP development on a non-localhost host |
