import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AttestationFields } from '../attestation/attestation.dto';
import { AttestationPurpose, AttestationService } from '../attestation/attestation.service';

/** hCaptcha / reCAPTCHA server-side verification. Disabled when no secret is configured (non-production only). */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger('Captcha');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, private readonly attestation: AttestationService) {}

  /**
   * Bot check for public account endpoints. The portal proves a human with CAPTCHA; the Citizen
   * app has no CAPTCHA and proves a genuine app on a genuine phone with Play Integrity instead.
   */
  async assertHumanOrApp(dto: AttestationFields & { captchaToken?: string }, purpose: AttestationPurpose, ip: string): Promise<void> {
    const appProof = !!(dto.integrityToken || dto.attestationChallenge || dto.attestationError);
    if (appProof && this.attestation.mode !== 'off') {
      const verdict = await this.attestation.verify(purpose, 'citizen', dto); // throws when enforcing and not passing
      if (verdict === 'FAILED' || verdict === 'UNVERIFIED') {
        this.logger.warn(`${purpose}: app not attested (${verdict}${dto.attestationError ? `, ${dto.attestationError}` : ''}); monitor mode lets it through`);
      }
      return;
    }
    await this.assertHuman(dto.captchaToken, ip);
  }

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
