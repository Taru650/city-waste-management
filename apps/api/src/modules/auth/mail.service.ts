import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

export const MAIL_SERVICE = Symbol('MAIL_SERVICE');

export interface MailService {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Development transport: writes mail to the log (never used in production; config refuses it). */
@Injectable()
export class LogMailService implements MailService {
  private readonly logger = new Logger('Mail');

  async send(to: string, subject: string, text: string): Promise<void> {
    const masked = to.replace(/^(.).*(@.*)$/, '$1***$2');
    this.logger.log(`To: ${masked} | ${subject}\n${text}`);
  }
}

/** SMTP (government mail relay, SES SMTP, etc.). Production requires TLS (smtps:// or requireTLS). */
@Injectable()
export class SmtpMailService implements MailService {
  private readonly transporter: Transporter;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.transporter = createTransport(config.mail.smtpUrl!);
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    await this.transporter.sendMail({ from: this.config.mail.from, to, subject, text });
  }
}
