// Fills ${API_TOKEN}, ${PORTAL_COOKIE}, ${REPORT_DIR} in the ZAP plan (ZAP's replacer does not
// expand environment variables). PLAN_IN → PLAN_OUT; fails on any placeholder left.
import { readFileSync, writeFileSync } from 'node:fs';

let t = readFileSync(process.env.PLAN_IN, 'utf8');
for (const k of ['API_TOKEN', 'PORTAL_COOKIE', 'REPORT_DIR']) {
  if (!process.env[k]) throw new Error(`${k} is not set`);
  t = t.split('${' + k + '}').join(process.env[k]);
}
const left = t.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').match(/\$\{[A-Z_]+\}/);
if (left) throw new Error(`unrendered placeholder ${left[0]}`);
writeFileSync(process.env.PLAN_OUT, t, { mode: 0o600 });
