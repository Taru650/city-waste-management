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
apps/api      NestJS + PostgreSQL/PostGIS — the single REST API for mobile apps and web portal
apps/web      Next.js portal (M6)
apps/mobile_* Flutter Citizen and Staff apps (M7)
infra/        docker-compose (pilot); k8s later
docs/         plan, milestones, security
```

See [`apps/api/README.md`](apps/api/README.md) to run the API and its tests.
