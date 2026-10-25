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

## Design system
- **Tokens** live in `src/theme.ts` (antd theme: navy structure, royal-blue actions, teal accent; green / amber / red only
  for status) and are mirrored as CSS variables in `src/app/globals.css`. Use them instead of literal colours.
- **Shell** (`components/AppShell.tsx`): navy sidebar from 992 px up; below that a top bar with a drawer menu. The switch
  is done in CSS (`.app-sider`, `.hide-lg`, `.show-md`), so the first render never flashes the wrong layout.
- **Pages** start with `components/PageHeader.tsx` (title, subtitle, actions that wrap on narrow screens). Reports add
  `PrintHeader`, which only appears on paper (A4, page numbers via `@page`).
- **Tables** always set `scroll.x` so they scroll inside their card; the page itself must never scroll sideways.
- `e2e/responsive.spec.ts` enforces this at 1920, 1366, 1024, 768 and 390 px (no sideways scroll, titles not squeezed,
  navigation reachable, print layout). `SCREENSHOTS_DIR=/tmp/shots npm run test:e2e -- responsive` saves screenshots.

## Configuration
| Variable | Purpose |
|---|---|
| `API_URL` | Internal API base URL (server-side only) |
| `PORTAL_ORIGIN` | Public origin of the portal (CSRF origin check, HTTPS upgrades) |
| `MEDIA_ORIGINS` | Public S3/MinIO origin(s) the browser may load evidence from (CSP) |
| `MAP_TILE_URL` | Map tiles (use MapmyIndia/Bhuvan or self-hosted tiles in production) |
| `COOKIE_SECURE` | `false` only for plain-HTTP development on a non-localhost host |
