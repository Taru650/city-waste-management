# Load test results (2026-10-25)

One 4-core / 15 GB machine running **everything**: k6 (including P-256 signing for every capture),
the API (single Node process), PostgreSQL 16 + PostGIS, Redis and the moto S3 emulator. No ClamAV.
One ULB (all load on one complaint-number sequence). Target: 2.8 complaints/s = 10,000/hour
(10× a 1,000/day city in one hour). Each complaint = 3 photos (filing, work start, resolution).

| Run | Encoder | Rate (target) | Filed / resolved | Failed requests | Media confirm p95 | Filing p95 | API CPU (cores) | Thresholds |
|---|---|---|---|---|---|---|---|---|
| 10-min hold | mozjpeg | 2.8/s (1×) | 1,763 / 1,749 | 0.00 % | 1.24 s | 103 ms | 2.9 avg | all pass |
| 3-min hold | mozjpeg | 5.6/s (2×) | 1,164 / 500 | 0.00 % | **7.7 s** | 151 ms | ~3.5 | confirm, login fail |
| 3-min hold | turbo | 5.6/s (2×) | 1,176 / 1,135 | 0.00 % | 333 ms | 84 ms | 1.4 avg | all pass |
| 3-min hold | turbo | 11.2/s (4×) | 2,341 / 1,201 | 0.00 % | 1.19 s | **3.4 s** | 1.8 avg (box load 8.8) | filing fails |

Other endpoints at 1× (mozjpeg run): login p95 590 ms (Argon2id by design), upload-url 52 ms,
lists 52 ms, assign 74 ms, start 98 ms, resolve 92 ms, dashboard reports 535 ms. Field work kept
up (1,749 of 1,763 resolved within the run). Zero errors in every run, including overload.

## Findings
1. **Photo re-encoding was the bottleneck.** mozjpeg costs ~300 ms CPU per photo; libjpeg-turbo
   at the same quality ~40 ms (SSIM 0.995 for both on a 12 MP test photo) but files are ~50 %
   larger (192 KB vs 127 KB). Default is now `PHOTO_ENCODER=turbo`; set `mozjpeg` where storage
   matters more than peak CPU. Re-encoding itself stays (it strips metadata and neutralises
   crafted files).
2. **Login slows under image load:** Argon2 and image work share Node's libuv threadpool.
   Resolved by (1) at 2×; at higher load, run more API replicas.
3. **Knee at ~3× target on this box:** filing p95 crosses 1.5 s. Two causes: the whole machine
   is saturated (k6 included), and gap-free per-ULB numbering serialises filings within one ULB
   (a row lock per filing, by design). 3× target in one ULB is ~30,000 complaints/hour.
4. **Capacity guidance:** with `turbo`, one 4-vCPU API node handled 2× the 10× peak at ~35 % CPU (1.4 of 4 cores).
   Run 2 replicas for redundancy; add replicas for melas. Storage at peak: ~350 KB per photo stored
   (main + thumbnail) → 10,000 complaints/hour ≈ 10 GB/hour.

Raw k6 summaries and CPU samples are written to `results/` (not committed).
