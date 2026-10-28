// Rebuilds the e2e database from scratch (migrations + demo data) before the site starts.
import { spawnSync } from 'node:child_process';
import { prepareEnv } from './env.mjs';

const r = spawnSync('npm', ['run', 'db:reset'], { env: { ...process.env, ...prepareEnv }, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
