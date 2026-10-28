import nodemailer from 'nodemailer';
import { getConfig } from '@/config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

type Sender = (m: MailMessage) => Promise<void>;
let override: Sender | undefined;

/** Tests (and anything else) can capture outgoing mail instead of sending it. */
export function setMailSender(s: Sender | undefined) {
  override = s;
}

/**
 * Sends an email. MAIL_TRANSPORT=log prints it in the terminal (so password-reset links work on a laptop
 * without an email server); MAIL_TRANSPORT=smtp sends it through SMTP_URL.
 */
export async function sendMail(m: MailMessage): Promise<void> {
  if (override) return override(m);
  const { mail } = getConfig();
  if (mail.transport === 'smtp') {
    await nodemailer.createTransport(mail.smtpUrl).sendMail({ from: mail.from, to: m.to, subject: m.subject, text: m.text });
    return;
  }
  console.log(`\n[mail] To: ${m.to}\n[mail] Subject: ${m.subject}\n${m.text}\n`);
}
