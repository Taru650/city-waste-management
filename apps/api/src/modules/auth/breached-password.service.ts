import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

/**
 * Refuses passwords known from data breaches (Have I Been Pwned, k-anonymity range API): only the
 * first 5 hex characters of the SHA-1 are sent, and padded responses hide which suffix was wanted.
 * If the service cannot be reached the password is accepted (logged): an outage must not stop
 * registration, and the embedded deny-list still applies.
 */
@Injectable()
export class BreachedPasswordService {
  private readonly log = new Logger(BreachedPasswordService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async assertNotBreached(password: string): Promise<void> {
    if (await this.isBreached(password)) {
      throw new BadRequestException('Password has appeared in a data breach; please choose a different one');
    }
  }

  async isBreached(password: string): Promise<boolean> {
    const c = this.config.breachedPasswords;
    if (c.mode !== 'on') return false;
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await fetch(`${c.url}/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'cwm-grievance-api' },
        signal: AbortSignal.timeout(c.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const line of (await res.text()).split('\n')) {
        const [s, count] = line.trim().split(':');
        if (s === suffix) return Number(count) > 0; // padding entries have count 0
      }
      return false;
    } catch (err) {
      this.log.warn(`breached-password check unavailable, accepting: ${(err as Error).message}`);
      return false;
    }
  }
}
