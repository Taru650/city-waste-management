import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import { safeCell } from './reportRange';

export interface Column {
  key: string;
  header: string;
  width?: number;
}

/** CSV with RFC 4180 quoting, a UTF-8 BOM (so Excel shows Hindi correctly) and formula neutralising. */
export function toCsv(columns: Column[], rows: Record<string, unknown>[]): Buffer {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(safeCell(v));
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.header)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))];
  return Buffer.concat([Buffer.from('﻿'), Buffer.from(lines.join('\r\n'), 'utf8')]);
}

/** Rows written between pauses that let other requests run (one export must not stall the server). */
const XLSX_ROWS_PER_SLICE = 500;

/**
 * Excel through ExcelJS's streaming writer: rows are serialised as they are added, with inline strings, instead of
 * building the whole workbook model in memory first (a 50,000-row export used about 1.1 GB that way).
 */
export async function toXlsx(title: string, subtitle: string, columns: Column[], rows: Record<string, unknown>[]): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    out.on('end', resolve);
    out.on('error', reject);
  });

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  wb.creator = 'City Waste Management';
  wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.columns = columns.map((c) => ({ width: c.width ?? Math.max(12, c.header.length + 2) }));
  const titleRow = ws.addRow([title]);
  titleRow.font = { bold: true, size: 14 };
  titleRow.commit();
  const subtitleRow = ws.addRow([subtitle]);
  subtitleRow.font = { italic: true, color: { argb: 'FF666666' } };
  subtitleRow.commit();
  ws.addRow([]).commit();
  const header = ws.addRow(columns.map((c) => c.header));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0EA' } };
  });
  header.commit();
  for (let i = 0; i < rows.length; i++) {
    ws.addRow(columns.map((c) => safeCell(rows[i][c.key] ?? null))).commit();
    if ((i + 1) % XLSX_ROWS_PER_SLICE === 0) await new Promise((r) => setImmediate(r));
  }
  ws.commit();
  await wb.commit();
  await done;
  return Buffer.concat(chunks);
}
