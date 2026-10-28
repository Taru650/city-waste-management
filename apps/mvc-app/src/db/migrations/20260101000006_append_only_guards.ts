import type { Knex } from 'knex';

/**
 * History tables are append-only: the database itself refuses UPDATE and DELETE on them
 * (feedback allows one exception: clearing the free-text remark when a citizen erases their account).
 *
 * MySQL only lets a user create triggers when binary logging is off, the user has SUPER, or the server
 * setting log_bin_trust_function_creators=1 is on. Where that is not the case this migration does NOT fail:
 * it prints a warning and the app still enforces append-only in code (the models expose no update or delete).
 * To switch the database-level guard on, run once as the MySQL admin:  SET GLOBAL log_bin_trust_function_creators = 1;
 * and then:  npm run db:guards
 */
export const config = { transaction: false };

const NEEDS_SUPER = (e: unknown) => {
  const err = e as { errno?: number; code?: string };
  return err.errno === 1419 || err.code === 'ER_BINLOG_CREATE_ROUTINE_NEED_SUPER';
};

export const GUARD_TRIGGERS: { name: string; table: string; sql: string }[] = [
  ...(['complaint_events', 'audit_logs'] as const).flatMap((table) =>
    (['UPDATE', 'DELETE'] as const).map((op) => ({
      name: `${table}_no_${op.toLowerCase()}`,
      table,
      sql: `CREATE TRIGGER ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} FOR EACH ROW
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`,
    })),
  ),
  {
    name: 'feedback_no_delete',
    table: 'feedback',
    sql: `CREATE TRIGGER feedback_no_delete BEFORE DELETE ON feedback FOR EACH ROW
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feedback is append-only'`,
  },
  {
    name: 'feedback_guard_update',
    table: 'feedback',
    sql: `CREATE TRIGGER feedback_guard_update BEFORE UPDATE ON feedback FOR EACH ROW
          BEGIN
            IF NOT (NEW.remark IS NULL AND NEW.id <=> OLD.id AND NEW.complaint_id <=> OLD.complaint_id
                    AND NEW.citizen_id <=> OLD.citizen_id AND NEW.rating <=> OLD.rating
                    AND NEW.reopen_requested <=> OLD.reopen_requested AND NEW.created_at <=> OLD.created_at) THEN
              SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feedback is append-only (only clearing the remark for erasure is allowed)';
            END IF;
          END`,
  },
];

/** Creates the guards; returns false (and warns) when MySQL refuses because of binary logging. */
export async function installGuards(knex: Knex, log: (m: string) => void = console.warn): Promise<boolean> {
  for (const t of GUARD_TRIGGERS) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${t.name}`);
    try {
      await knex.raw(t.sql);
    } catch (e) {
      if (!NEEDS_SUPER(e)) throw e;
      log(
        '\n  NOTE: database-level append-only guards were NOT created (MySQL binary logging is on and this user lacks SUPER).\n' +
          '  The app still enforces append-only in code. To enable the guards, as the MySQL admin run:\n' +
          '      SET GLOBAL log_bin_trust_function_creators = 1;\n' +
          '  then:  npm run db:guards\n',
      );
      return false;
    }
  }
  return true;
}

export async function up(knex: Knex): Promise<void> {
  await installGuards(knex);
}

export async function down(knex: Knex): Promise<void> {
  for (const t of GUARD_TRIGGERS) await knex.raw(`DROP TRIGGER IF EXISTS ${t.name}`);
}
