# City Waste Management — Citizen Grievance System

Citizens report garbage, water logging, drain blockage and other cleanliness problems with
in-app camera photos/video. Complaints route to the area supervisor of the location, are
assigned to sanitation workers, resolved with geotagged proof, and rated by the citizen.
Sub Admins (Nagar Nigam / Parishad / Panchayat) and District Admins get pendency and quality analytics.

- Plan: [`docs/PLAN.md`](docs/PLAN.md)
- Milestones and status: [`docs/MILESTONES.md`](docs/MILESTONES.md)
- Security controls → tests: [`docs/SECURITY.md`](docs/SECURITY.md)

## Repository layout
```
apps/api               NestJS + PostgreSQL/PostGIS — the single REST API for mobile apps and web portal
apps/web               Next.js portal for administrators and supervisors (dashboard, complaints, masters, staff)
apps/mobile_citizen    Flutter Citizen app (Swachh Seva)
apps/mobile_staff      Flutter Staff app for supervisors and field workers (Swachh Seva Staff)
packages/flutter_core  shared Dart: API client, camera capture + signing, offline outbox, Hindi/English
infra/                 docker-compose (pilot); load/ k6 load + soak; ops/ backup + restore drill; security/ OWASP ZAP DAST
docs/                  plan, milestones, security; ops/ pilot runbook, incident response, audit pack
```

See [`apps/api/README.md`](apps/api/README.md), [`apps/web/README.md`](apps/web/README.md) and [`packages/flutter_core/README.md`](packages/flutter_core/README.md) (both mobile apps) to run each app and its tests.
