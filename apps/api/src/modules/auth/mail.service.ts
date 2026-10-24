import { Injectable, Logger } from '@nestjs/common';

export const MAIL_SERVICE = Symbol('MAIL_SERVICE');

export interface MailService {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Development transport: writes mail to the log. Replace with SMTP/SES transport in production. */
@Injectable()
export class LogMailService implements MailService {
  private readonly logger = new Logger('Mail');

  async send(to: string, subject: string, text: string): Promise<void> {
    const masked = to.replace(/^(.).*(@.*)$/, '$1***$2');
    this.logger.log(`To: ${masked} | ${subject}\n${text}`);
  }
}
