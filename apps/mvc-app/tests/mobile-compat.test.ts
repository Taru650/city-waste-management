import { describe, expect, it } from 'vitest';
import { POST as challenge } from '@/app/api/v1/attestation/challenge/route';
import { call, setupTestEnvironment } from './helpers';

setupTestEnvironment();

/** Things the existing Flutter apps rely on, which the website never touches. */
describe('mobile app compatibility', () => {
  it('answers the attestation challenge with "not enabled", so the apps carry on without Play Integrity', async () => {
    for (const purpose of ['register', 'forgot-password', 'device']) {
      const r = await call(challenge, 'POST', '/api/v1/attestation/challenge', { body: { purpose } });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ enabled: false });
    }
  });

  it('still validates what is sent to it', async () => {
    expect((await call(challenge, 'POST', '/x', { body: { purpose: 'something-else' } })).status).toBe(400);
    expect((await call(challenge, 'POST', '/x', { body: { purpose: 'device', extra: 1 } })).status).toBe(400);
    expect((await call(challenge, 'POST', '/x', { body: {} })).status).toBe(400);
  });
});
