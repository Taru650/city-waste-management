import ExcelJS from 'exceljs';
import { safeCell } from './report-range';

export interface Column {
  key: string;
  header: string;
  width?: number;
}

/** CSV with RFC 4180 quoting, a UTF-8 BOM (so Excel shows Hindi correctly) and formula neutralising. */
export function toCsv(columns: Column[], rows: Record<string, unknown>[]): Buffer {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(safeCell(typeof v === 'string' ? v : v));
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.header)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))];
  return Buffer.concat([Buffer.from('﻿'), Buffer.from(lines.join('\r\n'), 'utf8')]);
}

export async function toXlsx(title: string, subtitle: string, columns: Column[], rows: Record<string, unknown>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'City Waste Management';
  wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([subtitle]).font = { italic: true, color: { argb: 'FF666666' } };
  ws.addRow([]);
  const header = ws.addRow(columns.map((c) => c.header));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0EA' } };
  });
  columns.forEach((c, i) => (ws.getColumn(i + 1).width = c.width ?? Math.max(12, c.header.length + 2)));
  for (const r of rows) ws.addRow(columns.map((c) => safeCell(r[c.key] ?? null)));
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
