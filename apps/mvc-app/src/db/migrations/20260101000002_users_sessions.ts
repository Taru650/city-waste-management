import type { Knex } from 'knex';
import { ID, NOW, TABLE_OPTIONS, TS } from '../ddl';

/**
 * Users (citizens and staff), login sessions and consent records.
 * Mobile and email are stored encrypted (AES-256-GCM) with a keyed hash ("blind index") for lookups;
 * password reset and refresh tokens are stored only as SHA-256 hashes.
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS users (
      id ${ID} NOT NULL DEFAULT (UUID()),
      role enum('WEB_ADMIN','DISTRICT_ADMIN','SUB_ADMIN','SUPERVISOR','WORKER','CITIZEN') NOT NULL,
      status enum('ACTIVE','UNVERIFIED_MOBILE','DISABLED') NOT NULL,
      name varchar(100) NOT NULL,
      guardian_name varchar(100) NULL,
      mobile_enc text NULL,
      mobile_hash char(64) NULL,
      email_enc text NULL,
      email_hash char(64) NULL,
      password_hash varchar(255) NOT NULL,
      must_change_password tinyint(1) NOT NULL DEFAULT 0,
      token_version int NOT NULL DEFAULT 0,
      failed_login_count int NOT NULL DEFAULT 0,
      locked_until ${TS} NULL,
      preferred_language char(2) NOT NULL DEFAULT 'hi',
      district_id ${ID} NULL,
      ulb_id ${ID} NULL,
      area_id ${ID} NULL,
      home_district_id ${ID} NULL,
      home_ulb_id ${ID} NULL,
      home_ward_id ${ID} NULL,
      access_expires_at ${TS} NULL,
      erased_at ${TS} NULL,
      created_by ${ID} NULL,
      last_login_at ${TS} NULL,
      created_at ${TS} NOT NULL ${NOW},
      updated_at ${TS} NOT NULL ${NOW} ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY users_mobile_hash_uq (mobile_hash),
      UNIQUE KEY users_email_hash_uq (email_hash),
      KEY users_ulb_role_idx (ulb_id, role),
      KEY users_district_role_idx (district_id, role),
      CONSTRAINT users_district_fk FOREIGN KEY (district_id) REFERENCES districts (id),
      CONSTRAINT users_ulb_fk FOREIGN KEY (ulb_id) REFERENCES ulbs (id),
      CONSTRAINT users_home_district_fk FOREIGN KEY (home_district_id) REFERENCES districts (id),
      CONSTRAINT users_home_ulb_fk FOREIGN KEY (home_ulb_id) REFERENCES ulbs (id),
      CONSTRAINT users_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id),
      CONSTRAINT users_lang_chk CHECK (preferred_language IN ('hi','en')),
      CONSTRAINT users_scope_chk CHECK (
        role = 'WEB_ADMIN'
        OR (role = 'DISTRICT_ADMIN' AND district_id IS NOT NULL)
        OR (role IN ('SUB_ADMIN','SUPERVISOR','WORKER') AND district_id IS NOT NULL AND ulb_id IS NOT NULL)
        OR (role = 'CITIZEN' AND (home_ward_id IS NOT NULL OR erased_at IS NOT NULL))
      ),
      CONSTRAINT users_contact_chk CHECK (erased_at IS NOT NULL OR (mobile_enc IS NOT NULL AND mobile_hash IS NOT NULL))
    ) ${TABLE_OPTIONS}`);
  // The circular references (users <-> areas / wards) are closed now that both sides exist.
  await knex.raw(`ALTER TABLE users ADD CONSTRAINT users_area_fk FOREIGN KEY (area_id) REFERENCES areas (id)`);
  await knex.raw(`ALTER TABLE users ADD CONSTRAINT users_home_ward_fk FOREIGN KEY (home_ward_id) REFERENCES wards (id)`);
  await knex.raw(`ALTER TABLE areas ADD CONSTRAINT areas_supervisor_fk FOREIGN KEY (supervisor_id) REFERENCES users (id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id ${ID} NOT NULL DEFAULT (UUID()),
      user_id ${ID} NOT NULL,
      family_id ${ID} NOT NULL,
      token_hash char(64) NOT NULL,
      expires_at ${TS} NOT NULL,
      used_at ${TS} NULL,
      revoked_at ${TS} NULL,
      ip varchar(64) NULL,
      user_agent varchar(255) NULL,
      created_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      UNIQUE KEY refresh_tokens_hash_uq (token_hash),
      KEY refresh_tokens_family_idx (family_id),
      KEY refresh_tokens_user_idx (user_id),
      CONSTRAINT refresh_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ${TABLE_OPTIONS}`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id ${ID} NOT NULL DEFAULT (UUID()),
      user_id ${ID} NOT NULL,
      token_hash char(64) NOT NULL,
      expires_at ${TS} NOT NULL,
      used_at ${TS} NULL,
      created_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      UNIQUE KEY password_resets_hash_uq (token_hash),
      KEY password_resets_user_idx (user_id),
      CONSTRAINT password_resets_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ${TABLE_OPTIONS}`);
  // DPDP Act 2023: consent per notice version and purpose; withdrawing it closes the account.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS consents (
      id ${ID} NOT NULL DEFAULT (UUID()),
      user_id ${ID} NOT NULL,
      purpose varchar(40) NOT NULL,
      notice_version varchar(20) NOT NULL,
      language char(2) NOT NULL,
      granted_at ${TS} NOT NULL ${NOW},
      withdrawn_at ${TS} NULL,
      PRIMARY KEY (id),
      KEY consents_user_idx (user_id),
      CONSTRAINT consents_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ${TABLE_OPTIONS}`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['consents', 'password_resets', 'refresh_tokens']) await knex.raw(`DROP TABLE IF EXISTS ${t}`);
  await knex.raw('ALTER TABLE areas DROP FOREIGN KEY areas_supervisor_fk').catch(() => undefined);
  await knex.raw('DROP TABLE IF EXISTS users');
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
}
