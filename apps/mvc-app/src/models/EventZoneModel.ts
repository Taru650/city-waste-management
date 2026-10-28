import type { Db } from '@/db/sql';
import { one } from '@/db/sql';

export const EventZoneModel = {
  /**
   * The zone a new complaint at this point falls into, if any: active now, same ULB. Overlaps are refused when zones
   * are created, so at most one matches. Its supervisor is returned only while that account is active and unexpired.
   */
  zoneFor(d: Db, ulbId: string, lng: number, lat: number) {
    return one<{ id: string; sla_hours: number | null; supervisor_id: string | null }>(
      d,
      `SELECT z.id, z.sla_hours,
              (SELECT s.id FROM users s WHERE s.id = z.supervisor_id AND s.status = 'ACTIVE'
                  AND (s.access_expires_at IS NULL OR s.access_expires_at > NOW(3))) AS supervisor_id
         FROM event_zones z
        WHERE z.active AND z.ulb_id = ? AND NOW(3) BETWEEN z.starts_at AND z.ends_at
          AND ST_Contains(z.geom, ST_PointFromText(CONCAT('POINT(', ?, ' ', ?, ')'), 4326, 'axis-order=long-lat'))
        LIMIT 1`,
      [ulbId, lng, lat],
    );
  },
};
