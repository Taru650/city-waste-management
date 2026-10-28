import { DataSource } from 'typeorm';
import { loadConfig } from '../config/configuration';
import { PiiCryptoService } from '../common/crypto/pii-crypto.service';
import { createDataSource } from './data-source';

export interface RotationReport {
  scanned: number;
  updated: number;
  /** Changed by the running app between read and write; run again. */
  retry: number;
  /** Readable with neither key: investigate before removing the previous key. */
  unreadable: string[];
  /** Users with unused MFA recovery codes (hashes cannot be recomputed): they must regenerate them. */
  recoveryCodeUsers: number;
}

/**
 * Moves every stored personal value to the current keys: re-encrypts mobile, email and TOTP secret,
 * recomputes the mobile/email lookup indexes. Safe while the app runs (a row is only written if it is
 * unchanged since it was read) and resumable (rows already on the current keys are skipped).
 */
export async function rotatePiiKeys(ds: DataSource, pii: PiiCryptoService, batch = 500): Promise<RotationReport> {
  const report: RotationReport = { scanned: 0, updated: 0, retry: 0, unreadable: [], recoveryCodeUsers: 0 };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows: Row[] = await ds.query(
      `SELECT id, mobile_enc, mobile_hash, email_enc, email_hash, mfa_secret_enc FROM users WHERE id > $1 ORDER BY id LIMIT $2`,
      [after, batch],
    );
    if (!rows.length) break;
    for (const r of rows) {
      report.scanned += 1;
      let next: Row;
      try {
        next = moved(r, pii);
      } catch {
        report.unreadable.push(r.id);
        continue;
      }
      if (FIELDS.every((f) => next[f] === r[f])) continue;
      const res = await ds.query(
        `UPDATE users SET mobile_enc = $5, mobile_hash = $6, email_enc = $7, email_hash = $8, mfa_secret_enc = $9
          WHERE id = $1 AND mobile_enc IS NOT DISTINCT FROM $2 AND email_enc IS NOT DISTINCT FROM $3 AND mfa_secret_enc IS NOT DISTINCT FROM $4`,
        [r.id, r.mobile_enc, r.email_enc, r.mfa_secret_enc, next.mobile_enc, next.mobile_hash, next.email_enc, next.email_hash, next.mfa_secret_enc],
      );
      if (res[1] === 1) report.updated += 1;
      else report.retry += 1;
    }
    after = rows[rows.length - 1].id;
  }
  const [{ n }] = await ds.query(`SELECT count(DISTINCT user_id)::int AS n FROM mfa_recovery_codes WHERE used_at IS NULL`);
  report.recoveryCodeUsers = n;
  return report;
}

interface Row {
  id: string;
  mobile_enc: string | null;
  mobile_hash: string | null;
  email_enc: string | null;
  email_hash: string | null;
  mfa_secret_enc: string | null;
}
const FIELDS = ['mobile_enc', 'mobile_hash', 'email_enc', 'email_hash', 'mfa_secret_enc'] as const;

function moved(r: Row, pii: PiiCryptoService): Row {
  const reEncrypt = (v: string | null) => (v === null || pii.isCurrent(v) ? v : pii.encrypt(pii.decrypt(v)));
  return {
    id: r.id,
    mobile_enc: reEncrypt(r.mobile_enc),
    email_enc: reEncrypt(r.email_enc),
    mfa_secret_enc: reEncrypt(r.mfa_secret_enc),
    mobile_hash: r.mobile_enc === null ? r.mobile_hash : pii.blindIndex(pii.decrypt(r.mobile_enc)),
    email_hash: r.email_enc === null ? r.email_hash : pii.blindIndex(pii.decrypt(r.email_enc)),
  };
}

async function main() {
  const config = loadConfig();
  if (!config.piiEncryptionKeyPrevious && !config.piiHashKeyPrevious) {
    throw new Error('Set PII_ENCRYPTION_KEY_PREVIOUS and/or PII_HASH_KEY_PREVIOUS (the old keys) first; see docs/ops/INCIDENT_RESPONSE.md');
  }
  const ds = await createDataSource(config.databaseUrl).initialize();
  const r = await rotatePiiKeys(ds, new PiiCryptoService(config));
  await ds.destroy();
  process.stdout.write(`scanned ${r.scanned}, updated ${r.updated}, changed meanwhile (run again) ${r.retry}, unreadable ${r.unreadable.length}\n`);
  if (r.unreadable.length) process.stdout.write(`unreadable user ids: ${r.unreadable.join(', ')}\n`);
  if (config.piiHashKeyPrevious && r.recoveryCodeUsers) {
    process.stdout.write(`${r.recoveryCodeUsers} user(s) hold MFA recovery codes under the old index key: they must regenerate them before PII_HASH_KEY_PREVIOUS is removed\n`);
  }
  if (r.retry || r.unreadable.length) process.exit(2);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err}\n`);
    process.exit(1);
  });
}
