import { resolveRange, safeCell, todayIst } from './report-range';
import { toCsv } from './report-export';

describe('report range', () => {
  const now = new Date('2026-10-24T20:00:00Z'); // 01:30 IST on the 25th

  it('uses the IST calendar day for "today"', () => {
    expect(todayIst(now)).toBe('2026-10-25');
  });

  it('defaults to the last 30 days ending today', () => {
    expect(resolveRange(undefined, undefined, now)).toEqual({ from: '2026-09-26', to: '2026-10-25', days: 30 });
  });

  it('accepts a single day and a full year', () => {
    expect(resolveRange('2026-10-01', '2026-10-01').days).toBe(1);
    expect(resolveRange('2025-10-25', '2026-10-25').days).toBe(366);
  });

  it.each([
    ['2026-10-02', '2026-10-01', /after/],
    ['2025-01-01', '2026-10-25', /366/],
    ['2026-02-30', '2026-03-01', /Invalid/],
  ])('rejects %s..%s', (from, to, msg) => {
    expect(() => resolveRange(from, to)).toThrow(msg);
  });
});

describe('spreadsheet formula injection guard', () => {
  it.each(['=HYPERLINK("http://evil","x")', '+cmd|/c calc', '-2+3', '@SUM(A1)', '\t=1', '\r=1'])('neutralises %p', (v) => {
    expect(safeCell(v)).toBe(`'${v}`);
  });

  it('leaves normal text and numbers alone', () => {
    expect(safeCell('Kachra near Shiv Mandir')).toBe('Kachra near Shiv Mandir');
    expect(safeCell('कचरे का ढेर')).toBe('कचरे का ढेर');
    expect(safeCell(-5)).toBe(-5);
  });

  it('CSV output quotes properly, keeps Hindi via BOM and neutralises formulas', () => {
    const csv = toCsv([{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }], [{ a: 'x, "y"', b: '=1+1' }, { a: 'कचरा', b: 3 }]).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toEqual(['A,B', '"x, ""y""",\'=1+1', 'कचरा,3']);
  });
});
