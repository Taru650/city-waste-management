import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '@/config/env';
import { sendMail } from '@/lib/mail';
import { setupTestEnvironment } from './helpers';

setupTestEnvironment();

/** A minimal SMTP server that records what it is given (so the real SMTP path is exercised, not a mock). */
function fakeSmtp() {
  const received: { from?: string; to: string[]; data: string } = { to: [], data: '' };
  const server = net.createServer((socket) => {
    let inData = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of chunk.toString().split('\r\n').filter((l, i, a) => i < a.length - 1 || l)) {
        if (inData) {
          if (line === '.') { inData = false; socket.write('250 queued\r\n'); } else received.data += `${line}\n`;
        } else if (/^EHLO|^HELO/i.test(line)) socket.write('250 fake\r\n');
        else if (/^MAIL FROM:/i.test(line)) { received.from = line; socket.write('250 ok\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { received.to.push(line); socket.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; socket.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise<{ port: number; received: typeof received; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, received, close: () => new Promise((r) => server.close(() => r())) })),
  );
}

describe('e-mail over SMTP', () => {
  const saved = { transport: process.env.MAIL_TRANSPORT, url: process.env.SMTP_URL };
  beforeEach(() => resetConfigForTests());
  afterEach(() => {
    process.env.MAIL_TRANSPORT = saved.transport;
    if (saved.url === undefined) delete process.env.SMTP_URL; else process.env.SMTP_URL = saved.url;
    resetConfigForTests();
  });

  it('delivers the message to the configured server, to the right recipient only', async () => {
    const smtp = await fakeSmtp();
    try {
      process.env.MAIL_TRANSPORT = 'smtp';
      process.env.SMTP_URL = `smtp://127.0.0.1:${smtp.port}`;
      resetConfigForTests();
      await sendMail({ to: 'citizen@example.in', subject: 'Reset your password', text: 'Open https://example.in/reset-password?token=abc' });
      expect(smtp.received.to).toHaveLength(1);
      expect(smtp.received.to[0]).toContain('<citizen@example.in>');
      expect(smtp.received.data).toContain('Subject: Reset your password');
      expect(smtp.received.data).toContain('https://example.in/reset-password?token=abc');
    } finally {
      await smtp.close();
    }
  });

  it('a broken SMTP server surfaces as an error instead of silently losing the mail', async () => {
    process.env.MAIL_TRANSPORT = 'smtp';
    process.env.SMTP_URL = 'smtp://127.0.0.1:1'; // nothing listens here
    resetConfigForTests();
    await expect(sendMail({ to: 'a@example.in', subject: 's', text: 't' })).rejects.toThrow();
  });
});
