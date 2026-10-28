/**
 * Database command line: migrate, rollback, status, seed, reset, guards.
 * Run through npm:  npm run db:migrate | db:rollback | db:status | db:seed | db:reset | db:guards
 */
import knex, { Knex } from 'knex';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config/env';
import { connectionSettings } from '../src/db/connection';
import { installGuards } from '../src/db/migrations/20260101000006_append_only_guards';

const root = path.resolve(__dirname, '..');
const migrations = { directory: path.join(root, 'src/db/migrations'), extension: 'ts', loadExtensions: ['.ts'], tableName: 'knex_migrations' };
const seeds = { directory: path.join(root, 'src/db/seeds'), extension: 'ts', loadExtensions: ['.ts'] };

function open(): Knex {
  return knex({ ...connectionSettings(), migrations, seeds });
}

function fail(message: string, hint?: string): never {
  console.error(`\n  ERROR: ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('  More help: README.md, section "Troubleshooting".\n');
  process.exit(1);
}

function explain(err: unknown): never {
  const e = err as { code?: string; errno?: number; message?: string };
  const c = getConfig();
  switch (e.code) {
    case 'ECONNREFUSED':
      return fail(`Cannot connect to MySQL at ${c.db.host}:${c.db.port}.`, 'Is the MySQL service running? (Windows: open "Services", start "MySQL84"; or run  net start MySQL84  in an Administrator CMD.) Check DB_HOST and DB_PORT in .env.');
    case 'ER_ACCESS_DENIED_ERROR':
      return fail(`MySQL refused the user "${c.db.user}" or its password.`, 'Check DB_USER and DB_PASSWORD in .env, and that you ran the CREATE USER step of the setup guide.');
    case 'ER_BAD_DB_ERROR':
      return fail(`The database "${c.db.name}" does not exist.`, `Create it first:  mysql -u root -p -e "CREATE DATABASE ${c.db.name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"`);
    case 'ER_DBACCESS_DENIED_ERROR':
      return fail(`The user "${c.db.user}" has no rights on "${c.db.name}".`, `As root:  GRANT ALL ON ${c.db.name}.* TO '${c.db.user}'@'localhost';`);
    case 'ENOTFOUND':
      return fail(`The MySQL host "${c.db.host}" was not found.`, 'Use 127.0.0.1 in DB_HOST for a MySQL on this computer.');
    default:
      console.error(err);
      return fail(e.message ?? 'Unexpected database error');
  }
}

async function requireMysql8(k: Knex) {
  const [rows] = (await k.raw('SELECT VERSION() AS v')) as unknown as [{ v: string }[]];
  const version = rows[0].v;
  if (/mariadb/i.test(version)) {
    fail(`This is MariaDB (${version}). The app needs MySQL 8.0 or newer (MariaDB's spatial functions differ).`, 'Install MySQL Community Server 8.4 from https://dev.mysql.com/downloads/mysql/ and point DB_PORT at it.');
  }
  const major = Number(version.split('.')[0]);
  if (major < 8) fail(`MySQL ${version} is too old; version 8.0 or newer is required.`);
}

async function main() {
  const [command = 'help', ...flags] = process.argv.slice(2);
  const c = getConfig();
  if (c.production && ['reset', 'rollback'].includes(command)) {
    fail(`"${command}" is disabled when NODE_ENV=production (it would delete data).`);
  }
  const k = open();
  try {
    if (command !== 'help') await requireMysql8(k);
    switch (command) {
      case 'migrate': {
        const [batch, applied] = await k.migrate.latest();
        console.log(applied.length ? `Batch ${batch}: applied ${applied.length} migration(s)\n  ${applied.join('\n  ')}` : 'Database is up to date.');
        break;
      }
      case 'rollback': {
        const [batch, undone] = await k.migrate.rollback();
        console.log(undone.length ? `Rolled back batch ${batch}:\n  ${undone.join('\n  ')}` : 'Nothing to roll back.');
        break;
      }
      case 'status': {
        const [done, pending] = (await k.migrate.list()) as [{ name: string }[], { file: string }[]];
        console.log(`Database "${c.db.name}" on ${c.db.host}:${c.db.port}`);
        done.forEach((m) => console.log(`  [x] ${m.name}`));
        pending.forEach((m) => console.log(`  [ ] ${m.file}`));
        break;
      }
      case 'seed': {
        const [files] = await k.seed.run();
        console.log(`Seeded demo data (${files.length} seeders). Demo logins are listed in README.md.`);
        break;
      }
      case 'guards': {
        const ok = await installGuards(k);
        console.log(ok ? 'Database-level append-only guards are installed.' : 'Guards could not be installed (see note above).');
        break;
      }
      case 'reset': {
        if (!flags.includes('--yes')) fail('"reset" deletes ALL data in this database. Run it as:  npm run db:reset');
        if (!/(mvc|test|demo|dev)/i.test(c.db.name)) {
          fail(`Refusing to reset "${c.db.name}": the name does not look like a demo/dev database (it must contain mvc, demo, dev or test).`);
        }
        console.log(`Resetting database "${c.db.name}" (all tables are dropped and rebuilt)...`);
        await k.raw('SET FOREIGN_KEY_CHECKS = 0');
        const [tables] = (await k.raw('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"')) as unknown as [Record<string, string>[]];
        for (const t of tables) await k.raw('DROP TABLE IF EXISTS ??', [Object.values(t)[0]]);
        await k.raw('SET FOREIGN_KEY_CHECKS = 1');
        // The photos and videos of the dropped rows would only be orphans: clear the two folders the app writes them to.
        for (const dir of ['media', 'staging']) rmSync(path.resolve(c.storageDir, dir), { recursive: true, force: true });
        const [, applied] = await k.migrate.latest();
        console.log(`Applied ${applied.length} migrations.`);
        const [files] = await k.seed.run();
        console.log(`Seeded demo data (${files.length} seeders).`);
        break;
      }
      default:
        console.log('Usage: npm run db:migrate | db:rollback | db:status | db:seed | db:reset | db:guards');
    }
  } catch (err) {
    explain(err);
  } finally {
    await k.destroy();
  }
}

void main();
