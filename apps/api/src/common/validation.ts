/** Indian mobile number, 10 digits starting 6-9 (no +91 / leading 0). */
export const MOBILE_REGEX = /^[6-9]\d{9}$/;
/** Person names: letters (any script incl. Devanagari), spaces, dot, apostrophe, hyphen. */
export const NAME_REGEX = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
