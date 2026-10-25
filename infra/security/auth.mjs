// Signs in the seeded Sub Admin (with TOTP) to the API and to the portal BFF, prints shell exports
// for the ZAP plan: API_TOKEN and PORTAL_COOKIE.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '../../apps/web');
const { authenticator } = createRequire(join(web, 'package.json'))('otplib');
const fx = JSON.parse(readFileSync(join(web, 'e2e/.auth/fixtures.json'), 'utf8'));
const u = fx.users.subAdminA;
const API = 'http://127.0.0.1:3100/api/v1';
const PORTAL = 'http://localhost:3200';
const json = { 'content-type': 'application/json' };
const nextStep = async () => { // a TOTP code is accepted once per 30 s window
  const now = Date.now();
  await new Promise((r) => setTimeout(r, 30_000 - (now % 30_000) + 500));
};

let r = await fetch(`${API}/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ identifier: u.mobile, password: u.password }) });
let b = await r.json();
r = await fetch(`${API}/auth/mfa/verify`, { method: 'POST', headers: json, body: JSON.stringify({ mfaToken: b.mfaToken, code: authenticator.generate(u.mfaSecret) }) });
b = await r.json();
if (!b.accessToken) throw new Error(`API login failed: ${JSON.stringify(b)}`);
const apiToken = b.accessToken;

await nextStep();
const bff = { ...json, 'x-cwm-csrf': '1', origin: PORTAL };
const jar = new Map();
const keep = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar.set(k, v); } };
r = await fetch(`${PORTAL}/bff/auth/login`, { method: 'POST', headers: bff, body: JSON.stringify({ identifier: u.mobile, password: u.password }) });
keep(r);
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
r = await fetch(`${PORTAL}/bff/auth/mfa-verify`, { method: 'POST', headers: { ...bff, cookie: cookie() }, body: JSON.stringify({ code: authenticator.generate(u.mfaSecret) }) });
keep(r);
if (!jar.has('cwm_at')) throw new Error(`portal login failed: ${r.status} ${await r.text()}`);
console.log(`export API_TOKEN='${apiToken}'`);
console.log(`export PORTAL_COOKIE='${cookie()}'`);
