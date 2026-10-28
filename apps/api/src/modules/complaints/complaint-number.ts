/**
 * Complaint number = DistrictLGD(4) + UlbLGD(6) + YY(2) + per-ULB yearly sequence(6), 18 digits.
 * Numeric only so it can be read out on a helpline or typed into an SMS.
 * Ward is deliberately excluded: wards get re-delimited, the number must never change.
 */
export const SEQ_MAX = 999_999;

export function buildComplaintNo(districtLgd: number, ulbLgd: number, year: number, seq: number): string {
  if (!Number.isInteger(districtLgd) || districtLgd < 1 || districtLgd > 9999) throw new RangeError('district LGD code out of range');
  if (!Number.isInteger(ulbLgd) || ulbLgd < 1 || ulbLgd > 999_999) throw new RangeError('ULB LGD code out of range');
  if (!Number.isInteger(seq) || seq < 1 || seq > SEQ_MAX) throw new RangeError('sequence out of range');
  const yy = String(year % 100).padStart(2, '0');
  return `${String(districtLgd).padStart(4, '0')}${String(ulbLgd).padStart(6, '0')}${yy}${String(seq).padStart(6, '0')}`;
}

/** 044680012326000457 → 0446-800123-26-000457 */
export function formatComplaintNo(no: string): string {
  return `${no.slice(0, 4)}-${no.slice(4, 10)}-${no.slice(10, 12)}-${no.slice(12)}`;
}

/** Accepts either the dashed or the plain form; returns the plain 18-digit form or null. */
export function normalizeComplaintNo(input: string): string | null {
  const digits = input.replace(/-/g, '');
  return /^\d{18}$/.test(digits) ? digits : null;
}
