import { z } from 'zod';

/** Indian mobile number, 10 digits starting 6-9 (no +91 / leading 0). */
export const MOBILE_REGEX = /^[6-9]\d{9}$/;
/** Person names: letters (any script incl. Devanagari), spaces, dot, apostrophe, hyphen. */
export const NAME_REGEX = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;

export const uuid = z.string().uuid();
export const mobile = z.string().regex(MOBILE_REGEX, 'Enter a 10-digit Indian mobile number');
export const personName = z.string().trim().min(2).max(100).regex(NAME_REGEX, 'Name may contain letters, spaces and . \' - only');
export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(1).max(128);
export const lat = z.coerce.number().min(-90).max(90);
export const lng = z.coerce.number().min(-180).max(180);

/** Page and pageSize from a query string, bounded so a request cannot ask for the whole table. */
export const paging = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
