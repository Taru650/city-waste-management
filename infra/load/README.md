# Load test (k6)

Target from the plan (§6): **10× the daily volume in one hour**. With the plan's sizing of
1,000 complaints/day, that is 10,000 complaints in an hour ≈ **2.8 complaints/s**, plus the field
work for them and the people looking at them:

| Actor | Scenario | What each iteration does |
|---|---|---|
| Citizens | arrival rate 168/min | capture a real 350 KB JPEG (unique per upload), signed with the phone's P-256 key → upload-url → PUT to storage → signed confirm (server: signature, hash, magic bytes, decode, re-encode, thumbnail) → file the complaint → list "my complaints" + unread count. A simulated phone files ≤ 9 complaints per citizen, then signs in as the next one (daily limit 10). |
| Supervisors (4) | constant | list new complaints in their area, assign each to a worker |
| Workers (40) | constant | take the next task: photo + start, 2–5 s "cleaning", photo + resolve |
| Officials | 0.5/s | dashboard: summary, trend, ageing, breakdown, hotspots (TOTP sign-in) |

## Run
```bash
go install go.k6.io/k6@v1.8.2            # or any k6 ≥ 1.0
node prepare.mjs                          # fresh DB cwm_load_test, moto S3, Redis DB 13, 10,000 citizens
./run-api.sh &                            # the built API (apps/api/dist), single process
./sample.sh &                             # CPU/RSS of API, PostgreSQL, Redis, moto → results/resources.csv
RATE=2.8 RAMP=1m HOLD=10m k6 run load.js  # → results/summary.json
```
**Soak (1 hour):** moto keeps objects in memory and does not last an hour; use MinIO:
`LOAD_S3=minio MINIO_BIN=/path/to/minio LOAD_CITIZENS=30000 LOAD_WORKERS=150 node prepare.mjs`, then
`./probe.sh &` (supervisor inbox latency every 15 s) and `RATE=2.8 HOLD=60m k6 run load.js`.
Workers above ~2 complaints/worker/hour hit the staff upload cap (300/day), so scale `LOAD_WORKERS` with `RATE`.

**Report scaling:** `node report-scale.mjs 365 1000` adds a year of history to one ULB and times
every dashboard report (`REUSE=1` re-times without regenerating). Results: [RESULTS.md](RESULTS.md).
`RATE` is complaints per second. Thresholds (the run fails if any is missed): < 1 % failed
requests, > 99 % checks, p95 < 1.5 s for filing / start / resolve / login, < 3 s for the media
confirm, < 800 ms for lists, < 2.5 s for dashboard reports.

## What this does not cover
- **One machine:** k6, the API, PostgreSQL, Redis and the S3 emulator share 4 cores, so the
  numbers are pessimistic for the API and say nothing about network latency.
- **No ClamAV:** production scans every upload; budget ~50–200 ms extra per confirm.
- **moto** stands in for S3; its latency is not representative (reported for information).
- **One hour, one machine:** the soak shows no latency drift and slow API memory growth; a
  multi-day soak on staging is still worth running before statewide rollout.
