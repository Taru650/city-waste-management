import { templates } from './templates';

const NO = '044680012326000457';

describe('notification templates', () => {
  const all = Object.entries(templates).map(([name, fn]) => [name, (fn as (n: string) => ReturnType<typeof templates.registered>)(NO)] as const);

  it.each(all)('%s has Hindi and English text within column limits', (_name, t) => {
    for (const lang of ['en', 'hi'] as const) {
      expect(t.title[lang].length).toBeGreaterThan(3);
      expect(t.title[lang].length).toBeLessThanOrEqual(120);
      expect(t.body[lang].length).toBeGreaterThan(3);
      expect(t.body[lang].length).toBeLessThanOrEqual(300);
    }
    expect(t.title.hi).toMatch(/[ऀ-ॿ]/);
    expect(t.type).toMatch(/^[A-Z_]+$/);
  });

  it.each(all.filter(([n]) => n !== 'mediaRejected'))('%s identifies the complaint by its public number only', (_name, t) => {
    expect(t.body.en).toContain('0446-800123-26-000457');
    expect(t.body.hi).toContain('0446-800123-26-000457');
  });
});
