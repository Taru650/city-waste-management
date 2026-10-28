import { SMTPServer } from 'smtp-server';
import { Role } from '../src/common/enums';
import { api, createJurisdiction, createTestApp, createUser, TestCtx } from './helpers';

/** Password reset mail over real SMTP (smtp-server stands in for the mail relay). */
describe('Email delivery over SMTP (M4)', () => {
  const saved = { t: process.env.MAIL_TRANSPORT, u: process.env.SMTP_URL };
  const received: { to: string[]; raw: string }[] = [];
  let smtp: SMTPServer;
  let port: number;
  let ctx: TestCtx;

  beforeAll(async () => {
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, session, cb) {
        let raw = '';
        stream.on('data', (d) => (raw += d));
        stream.on('end', () => {
          received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    port = (smtp.server.address() as { port: number }).port;
    process.env.MAIL_TRANSPORT = 'smtp';
    process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
    ctx = await createTestApp({ realMail: true });
  });
  afterAll(async () => {
    await ctx.app.close();
    await new Promise<void>((r) => smtp.close(() => r()));
    process.env.MAIL_TRANSPORT = saved.t;
    if (saved.u === undefined) delete process.env.SMTP_URL; else process.env.SMTP_URL = saved.u;
  });

  it('sends the reset link to the registered address', async () => {
    const j = await createJurisdiction(ctx.ds);
    const u = await createUser(ctx, Role.CITIZEN, j);
    await ctx.http().post(api('/auth/forgot-password')).send({ identifier: u.mobile }).expect(202);
    const mail = received.find((m) => m.to.includes(u.email));
    expect(mail).toBeDefined();
    expect(mail!.raw).toMatch(/reset-password\?token=3D|reset-password\?token=/);
    expect(mail!.raw).toMatch(/From: .*no-reply@example\.gov\.in/);
  });

  it('a mail outage does not change the response (no account enumeration, no 500)', async () => {
    const j = await createJurisdiction(ctx.ds);
    const u = await createUser(ctx, Role.CITIZEN, j);
    await new Promise<void>((r) => smtp.close(() => r()));
    const known = await ctx.http().post(api('/auth/forgot-password')).send({ identifier: u.email });
    const unknown = await ctx.http().post(api('/auth/forgot-password')).send({ identifier: 'nobody@example.in' });
    expect([known.status, known.body]).toEqual([unknown.status, unknown.body]);
    expect(known.status).toBe(202);
    // restart for afterAll
    smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'] });
    await new Promise<void>((r) => smtp.listen(port, '127.0.0.1', () => r()));
  });
});
