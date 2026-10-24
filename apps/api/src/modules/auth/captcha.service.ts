import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

/** hCaptcha / reCAPTCHA server-side verification. Disabled when no secret is configured (non-production only). */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger('Captcha');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async assertHuman(token: string | undefined, ip: string): Promise<void> {
    if (!this.config.captchaSecret) return;
    if (!token) throw new BadRequestException('CAPTCHA required');
    try {
      const res = await fetch(this.config.captchaVerifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: this.config.captchaSecret, response: token, remoteip: ip }),
      });
      const body = (await res.json()) as { success?: boolean };
      if (body.success) return;
    } catch (err) {
      this.logger.warn(`CAPTCHA verification failed: ${err}`);
    }
    throw new BadRequestException('CAPTCHA verification failed');
  }
}
