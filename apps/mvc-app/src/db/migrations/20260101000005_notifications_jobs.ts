import type { Knex } from 'knex';
import { ID, NOW, TABLE_OPTIONS, TS } from '../ddl';

/**
 * In-app notifications (they double as the push outbox), push tokens, and the background job queue.
 * The queue lives in MySQL, so the app needs no Redis: workers claim rows with FOR UPDATE SKIP LOCKED.
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS notifications (
      id ${ID} NOT NULL DEFAULT (UUID()),
      user_id ${ID} NOT NULL,
      type varchar(40) NOT NULL,
      complaint_id ${ID} NULL,
      title_en varchar(120) NOT NULL,
      title_hi varchar(120) NOT NULL,
      body_en varchar(300) NOT NULL,
      body_hi varchar(300) NOT NULL,
      push_status enum('PENDING','SENT','FAILED','SKIPPED') NOT NULL DEFAULT 'PENDING',
      push_attempts smallint NOT NULL DEFAULT 0,
      read_at ${TS} NULL,
      created_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      KEY notifications_user_idx (user_id, created_at),
      KEY notifications_push_idx (push_status, created_at),
      CONSTRAINT notifications_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT notifications_complaint_fk FOREIGN KEY (complaint_id) REFERENCES complaints (id)
    ) ${TABLE_OPTIONS}`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id ${ID} NOT NULL DEFAULT (UUID()),
      user_id ${ID} NOT NULL,
      token varchar(512) NOT NULL,
      platform varchar(20) NOT NULL,
      created_at ${TS} NOT NULL ${NOW},
      last_seen_at ${TS} NOT NULL ${NOW},
      PRIMARY KEY (id),
      UNIQUE KEY push_tokens_token_uq (token),
      KEY push_tokens_user_idx (user_id),
      CONSTRAINT push_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ${TABLE_OPTIONS}`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS jobs (
      id bigint unsigned NOT NULL AUTO_INCREMENT,
      queue varchar(30) NOT NULL,
      name varchar(60) NOT NULL,
      payload json NULL,
      status enum('PENDING','RUNNING','DONE','FAILED') NOT NULL DEFAULT 'PENDING',
      run_at ${TS} NOT NULL ${NOW},
      attempts int NOT NULL DEFAULT 0,
      max_attempts int NOT NULL DEFAULT 3,
      -- At most one waiting job per key (e.g. one "dispatch pushes" job, however many requests ask for it).
      dedupe_key varchar(120) NULL,
      live_dedupe_key varchar(120) GENERATED ALWAYS AS (IF(status IN ('PENDING','RUNNING'), dedupe_key, NULL)) STORED,
      locked_by varchar(60) NULL,
      locked_at ${TS} NULL,
      last_error text NULL,
      created_at ${TS} NOT NULL ${NOW},
      finished_at ${TS} NULL,
      PRIMARY KEY (id),
      UNIQUE KEY jobs_live_dedupe_uq (live_dedupe_key),
      KEY jobs_claim_idx (status, run_at, queue)
    ) ${TABLE_OPTIONS}`);
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['jobs', 'push_tokens', 'notifications']) await knex.raw(`DROP TABLE IF EXISTS ${t}`);
}
