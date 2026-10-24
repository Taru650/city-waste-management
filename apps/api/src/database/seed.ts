import * as argon2 from 'argon2';
import { loadConfig } from '../config/configuration';
import { PiiCryptoService } from '../common/crypto/pii-crypto.service';
import { ARGON2_OPTIONS } from '../modules/auth/auth.service';
import { assertStrongPassword } from '../modules/auth/password-policy';
import { createDataSource } from './data-source';

/**
 * Creates the first Web Admin (idempotent). That admin must enrol TOTP at first login
 * and change the seeded password. Everything else is created through the API.
 */
async function main() {
  const config = loadConfig();
  const mobile = process.env.SEED_ADMIN_MOBILE;
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!mobile || !email || !password) throw new Error('SEED_ADMIN_MOBILE, SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required');
  assertStrongPassword(password, { mobile, email });

  const pii = new PiiCryptoService(config);
  const ds = await createDataSource(config.databaseUrl).initialize();
  const [existing] = await ds.query(`SELECT id FROM users WHERE role = 'WEB_ADMIN' LIMIT 1`);
  if (existing) {
    process.stdout.write('A Web Admin already exists; nothing to do.\n');
  } else {
    await ds.query(
      `INSERT INTO users (role, status, name, mobile_enc, mobile_hash, email_enc, email_hash, password_hash, must_change_password)
       VALUES ('WEB_ADMIN', 'ACTIVE', 'Web Admin', $1, $2, $3, $4, $5, true)`,
      [pii.encrypt(mobile), pii.blindIndex(mobile), pii.encrypt(email), pii.blindIndex(email), await argon2.hash(password, ARGON2_OPTIONS)],
    );
    process.stdout.write('Web Admin created. Log in, enrol TOTP and change the password.\n');
  }
  await ds.destroy();
}

main().catch((err) => {
  process.stderr.write(`${err.message ?? err}\n`);
  process.exit(1);
});
