import { BadRequestException } from '@nestjs/common';

export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

/** Today's date in India (reports are bucketed by IST calendar days). */
export function todayIst(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isRealDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Resolves and validates the reporting window; bounded so a report cannot scan years of data. */
export function resolveRange(from?: string, to?: string, now = new Date()): { from: string; to: string; days: number } {
  const end = to ?? todayIst(now);
  const start = from ?? addDays(end, -(DEFAULT_RANGE_DAYS - 1));
  if (!isRealDate(start) || !isRealDate(end)) throw new BadRequestException('Invalid date');
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  if (days < 1) throw new BadRequestException('from must not be after to');
  if (days > MAX_RANGE_DAYS) throw new BadRequestException(`Date range is limited to ${MAX_RANGE_DAYS} days`);
  return { from: start, to: end, days };
}

/**
 * Neutralises spreadsheet formula injection (CWE-1236): text that a citizen typed,
 * like "=HYPERLINK(...)", must not execute when an official opens the export in Excel.
 */
export function safeCell(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
