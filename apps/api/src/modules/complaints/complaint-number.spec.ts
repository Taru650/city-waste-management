import { buildComplaintNo, formatComplaintNo, normalizeComplaintNo } from './complaint-number';

describe('complaint number', () => {
  it('builds an 18-digit number from LGD codes, year and sequence', () => {
    const no = buildComplaintNo(446, 800123, 2026, 457);
    expect(no).toBe('044680012326000457');
    expect(no).toHaveLength(18);
  });

  it('formats with dashes for display and parses either form back', () => {
    expect(formatComplaintNo('044680012326000457')).toBe('0446-800123-26-000457');
    expect(normalizeComplaintNo('0446-800123-26-000457')).toBe('044680012326000457');
    expect(normalizeComplaintNo('044680012326000457')).toBe('044680012326000457');
  });

  it.each(['', 'abc', '0446-800123-26-00045', "1' OR '1'='1", '04468001232600045799'])('rejects malformed input %p', (input) => {
    expect(normalizeComplaintNo(input)).toBeNull();
  });

  it.each([
    [0, 800123, 1], [10000, 800123, 1], [446, 0, 1], [446, 1_000_000, 1], [446, 800123, 0], [446, 800123, 1_000_000], [446.5, 800123, 1],
  ])('rejects out-of-range parts (%p, %p, %p)', (d, u, s) => {
    expect(() => buildComplaintNo(d, u, 2026, s)).toThrow(RangeError);
  });
});
