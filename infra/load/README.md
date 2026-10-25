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
`RATE` is complaints per second. Thresholds (the run fails if any is missed): < 1 % failed
requests, > 99 % checks, p95 < 1.5 s for filing / start / resolve / login, < 3 s for the media
confirm, < 800 ms for lists, < 2.5 s for dashboard reports.

## What this does not cover
- **One machine:** k6, the API, PostgreSQL, Redis and the S3 emulator share 4 cores, so the
  numbers are pessimistic for the API and say nothing about network latency.
- **No ClamAV:** production scans every upload; budget ~50–200 ms extra per confirm.
- **moto** stands in for S3; its latency is not representative (reported for information).
- **10-minute hold, not a full hour:** the rate is the hourly peak rate; an hour-long soak (for
  leaks and table growth) belongs on staging.
