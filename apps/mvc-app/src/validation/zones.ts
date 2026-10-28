import { z } from 'zod';
import { geoJsonPolygon } from '@/lib/geo';
import { uuid } from '@/lib/validators';

const when = z.iso.datetime({ offset: true });
const name = z.string().trim().min(3).max(120);
const sla = z.number().int().min(1).max(720);

export const createZoneSchema = z
  .object({
    /** ULB the zone belongs to (Sub Admins: always their own). */
    ulbId: uuid,
    name,
    boundary: geoJsonPolygon,
    startsAt: when,
    endsAt: when,
    /** Supervisor of the same ULB who handles complaints inside the zone. */
    supervisorId: uuid.optional(),
    /** Deadline in hours inside the zone; the shorter of this and the type SLA applies. */
    slaHours: sla.optional(),
  })
  .strict();

export const updateZoneSchema = z
  .object({
    name: name.optional(),
    boundary: geoJsonPolygon.optional(),
    startsAt: when.optional(),
    endsAt: when.optional(),
    supervisorId: uuid.nullable().optional(),
    slaHours: sla.nullable().optional(),
    /** false cancels the zone (open complaints are handed back). */
    active: z.boolean().optional(),
  })
  .strict();

export const listZonesQuery = z.object({ ulbId: uuid.optional(), when: z.enum(['current', 'upcoming', 'past', 'all']).default('all') });
