import { z } from 'zod';
import { ULB_TYPES } from '@/lib/enums';
import { geoJsonPolygon } from '@/lib/geo';
import { lat, lng, uuid } from '@/lib/validators';

export const createDistrictSchema = z
  .object({
    lgdCode: z.number().int().min(1).max(9999),
    census2011Code: z.number().int().min(1).max(9999).optional(),
    name: z.string().trim().min(2).max(100),
    nameHi: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const createUlbSchema = z
  .object({
    districtId: uuid,
    lgdCode: z.number().int().min(1).max(999999),
    type: z.enum(ULB_TYPES as [string, ...string[]]),
    name: z.string().trim().min(2).max(150),
    nameHi: z.string().trim().min(1).max(150).optional(),
    boundary: geoJsonPolygon.optional(),
  })
  .strict();

export const createWardSchema = z
  .object({
    ulbId: uuid,
    number: z.number().int().min(1).max(9999),
    name: z.string().trim().min(1).max(100).optional(),
    boundary: geoJsonPolygon.optional(),
  })
  .strict();

export const updateWardSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional(), boundary: geoJsonPolygon.optional(), active: z.boolean().optional() })
  .strict();

export const createAreaSchema = z
  .object({ ulbId: uuid, name: z.string().trim().min(1).max(100), supervisorId: uuid.optional(), wardIds: z.array(uuid).max(500) })
  .strict();

export const updateAreaSchema = z.object({ supervisorId: uuid.nullable().optional(), wardIds: z.array(uuid).max(500).optional() }).strict();

export const updateComplaintTypeSchema = z
  .object({ slaHours: z.number().int().min(1).max(24 * 30).optional(), active: z.boolean().optional() })
  .strict();

export const locateQuery = z.object({ lat, lng });
