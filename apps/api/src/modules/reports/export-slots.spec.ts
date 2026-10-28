import { HttpException } from '@nestjs/common';
import { ExportSlots } from './export-slots';

describe('ExportSlots', () => {
  const status = (fn: () => unknown) => {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return (e as HttpException).getStatus();
    }
  };

  it('allows one export per user and a fixed number overall', () => {
    const slots = new ExportSlots(2);
    const releaseA = slots.acquire('a');
    expect(status(() => slots.acquire('a'))).toBe(429);
    const releaseB = slots.acquire('b');
    expect(status(() => slots.acquire('c'))).toBe(429);
    releaseA();
    expect(status(() => slots.acquire('c'))).toBe('ok');
    releaseB();
    expect(slots.inUse).toBe(1);
  });

  it('releasing twice does not free someone else’s slot', () => {
    const slots = new ExportSlots(1);
    const release = slots.acquire('a');
    release();
    slots.acquire('b');
    release();
    expect(slots.inUse).toBe(1);
    expect(status(() => slots.acquire('c'))).toBe(429);
  });
});
