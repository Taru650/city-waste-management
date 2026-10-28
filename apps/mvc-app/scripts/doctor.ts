/**
 * "npm run doctor": checks everything the app needs and says what to fix, in plain words.
 * Safe to run any time; it only reads.
 */
import net from 'node:net';
import knex from 'knex';
import fs from 'node:fs';
import path from 'node:path';
import { buildConfig } from '../src/config/env';
import { config as loadDotenv } from 'dotenv';

type Result = { name: string; ok: boolean; detail: string; fix?: string };
const results: Result[] = [];
const check = (name: string, ok: boolean, detail: string, fix?: string) => results.push({ name, ok, detail, fix });

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  check('Node.js', major >= 20, `v${process.versions.node}`, 'Install Node.js 22 LTS from https://nodejs.org and open a NEW Command Prompt.');

  const envPath = path.resolve(__dirname, '../.env');
  const hasEnv = fs.existsSync(envPath);
  check('.env file', hasEnv, hasEnv ? 'found' : 'missing', 'In the project folder run:  copy .env.example .env   then   npm run gen:secrets');
  if (hasEnv) loadDotenv({ path: envPath, quiet: true });

  let cfg: ReturnType<typeof buildConfig> | undefined;
  try {
    cfg = buildConfig(process.env);
    check('Settings in .env', true, 'valid');
  } catch (e) {
    check('Settings in .env', false, (e as Error).message.split('\n').slice(0, 4).join(' | '), 'Fix the lines named above, or run  npm run gen:secrets  for the secret values.');
  }

  if (cfg) {
    const k = knex({
      client: 'mysql2',
      connection: { host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password, database: cfg.db.name, connectTimeout: 5000 },
      pool: { min: 0, max: 1 },
    });
    try {
      const [v] = (await k.raw('SELECT VERSION() AS v')) as unknown as [{ v: string }[]];
      const version = v[0].v;
      const isMaria = /mariadb/i.test(version);
      check('MySQL connection', true, `connected to ${cfg.db.host}:${cfg.db.port}, database "${cfg.db.name}"`);
      check('MySQL version', !isMaria && Number(version.split('.')[0]) >= 8, version, isMaria ? 'MariaDB is not supported. Install MySQL Community Server 8.4.' : 'MySQL 8.0 or newer is required.');
      const [p] = (await k.raw(`SELECT ST_Distance(ST_PointFromText('POINT(77.2 28.6)',4326,'axis-order=long-lat'), ST_PointFromText('POINT(77.2 28.601)',4326,'axis-order=long-lat')) AS m`)) as unknown as [{ m: number }[]];
      check('Spatial functions', Math.abs(p[0].m - 111) < 2, `0.001 degree = ${Math.round(p[0].m)} m`, 'The MySQL server does not support geographic spatial functions; use MySQL 8.0.14 or newer.');
      try {
        const [rows] = (await k.raw('SELECT COUNT(*) AS n FROM knex_migrations')) as unknown as [{ n: number }[]];
        check('Tables created', rows[0].n >= 6, `${rows[0].n} migrations applied`, 'Run:  npm run db:migrate');
        const [u] = (await k.raw('SELECT COUNT(*) AS n FROM users')) as unknown as [{ n: number }[]];
        check('Demo data', u[0].n > 0, `${u[0].n} users`, 'Run:  npm run db:seed');
      } catch {
        check('Tables created', false, 'no tables yet', 'Run:  npm run db:migrate   then   npm run db:seed');
      }
    } catch (e) {
      const err = e as { code?: string; message: string };
      const fixes: Record<string, string> = {
        ECONNREFUSED: 'MySQL is not running. Windows: start the "MySQL84" service (Services app, or "net start MySQL84" in an Administrator CMD).',
        ER_ACCESS_DENIED_ERROR: 'Wrong DB_USER / DB_PASSWORD in .env, or the user was not created (see README step "Create the database and user").',
        ER_BAD_DB_ERROR: `The database "${cfg.db.name}" does not exist. Create it (README step "Create the database and user").`,
      };
      check('MySQL connection', false, `${err.code ?? ''} ${err.message}`.trim(), fixes[err.code ?? ''] ?? 'Check DB_HOST, DB_PORT, DB_USER, DB_PASSWORD in .env.');
    } finally {
      await k.destroy();
    }
  }

  const free = await portFree(3000);
  check('Port 3000', free, free ? 'free' : 'in use', 'Another program uses port 3000. Close it, or start with a different port:  npx next dev -p 3100');

  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}: ${r.detail}`);
    if (!r.ok && r.fix) console.log(`        -> ${r.fix}`);
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad ? `\n  ${bad} problem(s) found. Fix them in order, then run "npm run doctor" again.\n` : '\n  Everything looks good. Start the app with:  npm run dev\n');
  process.exit(bad ? 1 : 0);
}

void main();
