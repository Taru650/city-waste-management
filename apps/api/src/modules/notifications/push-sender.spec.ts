import { AppConfig } from '../../config/configuration';
import { fakeFcm } from '../../../test/fake-fcm';
import { PushSender } from './push-sender';

describe('PushSender (FCM HTTP v1)', () => {
  let fcm: Awaited<ReturnType<typeof fakeFcm>>;
  let sender: PushSender;
  const msg = { title: 'Complaint resolved', body: 'Please rate', data: { complaintId: 'c1', type: 'COMPLAINT_RESOLVED' } };

  beforeAll(async () => {
    fcm = await fakeFcm();
    sender = new PushSender({
      fcm: { serviceAccountJson: Buffer.from(fcm.serviceAccountB64, 'base64').toString(), apiBase: fcm.apiBase },
    } as AppConfig);
  });
  afterAll(() => fcm.close());

  it('authenticates with a signed service-account JWT and delivers the message', async () => {
    await expect(sender.send('token-1', msg)).resolves.toBe('OK');
    expect(fcm.tokenRequests[0].assertionClaims).toEqual(expect.objectContaining({
      iss: 'push@cwm-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: expect.stringMatching(/\/token$/),
    }));
    expect(fcm.messages.at(-1)).toEqual({ token: 'token-1', notification: { title: msg.title, body: msg.body }, data: msg.data, android: { priority: 'HIGH' } });
  });

  it('caches the access token across sends and re-authenticates after a 401', async () => {
    const before = fcm.tokenRequests.length;
    await sender.send('token-2', msg);
    await sender.send('token-3', msg);
    expect(fcm.tokenRequests.length).toBe(before);
    fcm.rotateAccessToken();
    await expect(sender.send('token-4', msg)).resolves.toBe('RETRY');
    await expect(sender.send('token-4', msg)).resolves.toBe('OK');
    expect(fcm.tokenRequests.length).toBe(before + 1);
  });

  it('classifies failures: unregistered token, transient error, permanent error', async () => {
    await expect(sender.send('dead-token', msg)).resolves.toBe('UNREGISTERED');
    await expect(sender.send('flaky-token', msg)).resolves.toBe('RETRY');
    await expect(sender.send('bad-token', msg)).resolves.toBe('FAILED');
  });

  it('is a no-op without a service account', async () => {
    const off = new PushSender({ fcm: { apiBase: 'http://unused' } } as AppConfig);
    expect(off.enabled).toBe(false);
    await expect(off.send('t', msg)).resolves.toBe('SKIPPED');
  });

  it('refuses an incomplete service account at startup', () => {
    expect(() => new PushSender({ fcm: { serviceAccountJson: '{"project_id":"x"}', apiBase: 'x' } } as AppConfig)).toThrow(/incomplete/);
  });
});
