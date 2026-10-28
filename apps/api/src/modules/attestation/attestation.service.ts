import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';
import { APP_CONFIG, AppConfig, IntegrityLevel } from '../../config/configuration';
import { checkPayload, DeviceVerdict, IntegrityRejected, MAX_TOKEN_AGE_MS, PlayIntegrityClient } from './play-integrity';

export type AttestationPurpose = 'register' | 'forgot-password' | 'device';
export type App = 'citizen' | 'staff';

export interface AttestationProof {
  attestationChallenge?: string;
  integrityToken?: string;
  /** Set by the app when Play Integrity could not produce a token (no Play services, network, quota). */
  attestationError?: string;
}

/** UNVERIFIED: not attested (mode off, or monitor without a usable token). FAILED: monitor mode, checks failed. */
export type StoredVerdict = DeviceVerdict | 'UNVERIFIED' | 'FAILED';

const CHALLENGE_TTL_MS = MAX_TOKEN_AGE_MS;

/** 428 with a fresh challenge: the app must attest and retry. */
export class AttestationRequired extends HttpException {
  constructor(challenge: string) {
    super({ statusCode: 428, error: 'Precondition Required', message: 'Device attestation required', challenge }, HttpStatus.PRECONDITION_REQUIRED);
  }
}

/** The nonce given to Play Integrity: binds the token to this challenge and (for devices) to the key. */
export function integrityNonce(challenge: string, binding = ''): string {
  return createHash('sha256').update(`${challenge}|${binding}`).digest('base64url');
}

/**
 * Play Integrity for the mobile apps (the portal uses CAPTCHA). Challenges are stateless (HMAC,
 * purpose and expiry inside); a verified nonce is stored once, so a token cannot be replayed.
 */
@Injectable()
export class AttestationService {
  private readonly logger = new Logger('Attestation');
  private readonly client?: PlayIntegrityClient;
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, private readonly ds: DataSource) {
    const pi = config.playIntegrity;
    if (pi.mode !== 'off') this.client = new PlayIntegrityClient(pi);
    this.key = createHmac('sha256', config.jwtAccessSecret).update('attestation-challenge-v1').digest();
  }

  get mode() {
    return this.config.playIntegrity.mode;
  }

  issueChallenge(purpose: AttestationPurpose): { enabled: boolean; challenge?: string; expiresAt?: string } {
    if (this.mode === 'off') return { enabled: false };
    const exp = Date.now() + CHALLENGE_TTL_MS;
    const body = `${purpose}.${exp}.${randomBytes(16).toString('base64url')}`;
    return { enabled: true, challenge: `${body}.${this.mac(body)}`, expiresAt: new Date(exp).toISOString() };
  }

  /**
   * Verifies a proof for [purpose]. enforce: anything short of a passing verdict throws.
   * monitor: never throws for the verdict itself; returns FAILED/UNVERIFIED for the record.
   */
  async verify(purpose: AttestationPurpose, app: App, proof: AttestationProof, binding = ''): Promise<StoredVerdict> {
    if (this.mode === 'off') return 'UNVERIFIED';
    const enforce = this.mode === 'enforce';
    if (!proof.integrityToken || !proof.attestationChallenge) {
      if (enforce) throw new ForbiddenException('This phone could not be verified by Google Play. Update Google Play services and try again.');
      return 'UNVERIFIED';
    }
    this.assertChallenge(proof.attestationChallenge, purpose);
    const pi = this.config.playIntegrity;
    const nonce = integrityNonce(proof.attestationChallenge, binding);
    const packageName = app === 'citizen' ? pi.citizenPackage : pi.staffPackage;
    const minLevel: IntegrityLevel = app === 'citizen' ? pi.citizenLevel : pi.staffLevel;
    try {
      const payload = await this.client!.decode(packageName, proof.integrityToken);
      const verdict = checkPayload(payload, { packageName, nonce, certSha256: pi.certSha256, minLevel });
      await this.consumeNonce(nonce);
      return verdict;
    } catch (err) {
      if (err instanceof IntegrityRejected) {
        this.logger.warn(`Play Integrity rejected (${purpose}, ${app}): ${err.message}`);
        if (enforce) throw new ForbiddenException('This phone or app copy did not pass Google Play verification.');
        return 'FAILED';
      }
      // Google unreachable / quota: fail closed when enforcing, retryable.
      this.logger.warn(`Play Integrity unavailable: ${err}`);
      if (enforce) throw new ServiceUnavailableException('Verification service unavailable, please try again shortly.');
      return 'UNVERIFIED';
    }
  }

  private assertChallenge(challenge: string, purpose: AttestationPurpose) {
    const i = challenge.lastIndexOf('.');
    if (i < 0) throw new BadRequestException('Invalid attestation challenge');
    const body = challenge.slice(0, i);
    const mac = Buffer.from(challenge.slice(i + 1));
    const good = Buffer.from(this.mac(body));
    if (mac.length !== good.length || !timingSafeEqual(mac, good)) throw new BadRequestException('Invalid attestation challenge');
    const [p, exp] = body.split('.');
    if (p !== purpose) throw new BadRequestException('Attestation challenge was issued for another action');
    if (!(Number(exp) > Date.now())) throw new BadRequestException('Attestation challenge expired');
  }

  private async consumeNonce(nonce: string) {
    const hash = createHash('sha256').update(nonce).digest();
    const rows = await this.ds.query(
      `INSERT INTO attestation_nonces (nonce_hash, expires_at) VALUES ($1, now() + interval '1 day')
       ON CONFLICT DO NOTHING RETURNING 1`,
      [hash],
    );
    if (!rows.length) throw new IntegrityRejected('replayed nonce');
  }

  private mac(body: string) {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }

  /** Housekeeping (hourly job): replay records are only needed while a challenge could be valid. */
  async purgeExpired() {
    await this.ds.query(`DELETE FROM attestation_nonces WHERE expires_at < now()`);
  }
}
