-- Read-only: active wards of the same ULB whose boundaries overlap by more than 100 m².
-- Run before go-live and after bulk boundary imports done outside the portal:
--   psql "$DATABASE_URL" -f infra/sql/check-ward-overlaps.sql
-- The portal and API refuse such boundaries since the 2026-10 audit; data loaded earlier or
-- directly into the database is not checked. Any row here means a GPS point in the overlap is
-- routed to one of the two wards (consistently, the one with the lower id).
SELECT u.name AS ulb, a.number AS ward_a, b.number AS ward_b,
       round(ST_Area(ST_Intersection(a.geom, b.geom)::geography)) AS overlap_m2
  FROM wards a
  JOIN wards b ON b.ulb_id = a.ulb_id AND a.id < b.id AND a.active AND b.active
  JOIN ulbs u ON u.id = a.ulb_id
 WHERE ST_Intersects(a.geom, b.geom)
   AND ST_Area(ST_Intersection(a.geom, b.geom)::geography) > 100
 ORDER BY overlap_m2 DESC;
