#!/usr/bin/env bash
# Authenticated OWASP ZAP scan of the e2e environment (real API + portal + seed data).
#   ZAP_HOME=/path/to/ZAP_2.16.1 ./run-zap.sh   → results/zap-report.{html,json}
# Requires: apps/api and apps/web built, PostgreSQL/PostGIS, Redis, moto (as for Playwright).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
: "${ZAP_HOME:?set ZAP_HOME to the unpacked ZAP directory}"
export REPORT_DIR="$HERE/results"
mkdir -p "$REPORT_DIR"
cd "$ROOT/apps/web"
node e2e/prepare.mjs
eval "$(node -e "import('./e2e/env.mjs').then(m => { for (const [k,v] of Object.entries({...m.apiEnv, ACCESS_TOKEN_TTL_SECONDS: '7200'})) console.log('export '+k+'='+JSON.stringify(v)) })")"
node "$ROOT/apps/api/dist/main.js" > "$REPORT_DIR/api.log" 2>&1 &
API_PID=$!
WEB_ENV=$(node -e "import('./e2e/env.mjs').then(m => { for (const [k,v] of Object.entries(m.webEnv)) console.log(k+'='+JSON.stringify(v)) })")
env $(echo "$WEB_ENV" | xargs) NODE_ENV=production npx next start -p 3200 > "$REPORT_DIR/web.log" 2>&1 &
WEB_PID=$!
node "$HERE/log-proxy.mjs" 3101 3100 "$REPORT_DIR/api-requests.csv" &
PROXY_PID=$!
trap 'kill $API_PID $WEB_PID $PROXY_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do curl -sf http://127.0.0.1:3100/api/v1/health/ready >/dev/null && curl -sf -o /dev/null http://localhost:3200/login && break; sleep 0.5; done
eval "$(node "$HERE/auth.mjs")"
# ZAP's replacer does not expand environment variables (it sent the literal "${API_TOKEN}" in an
# earlier run, so everything was a 401): render the plan with real values into a private file.
PLAN=$(mktemp --suffix=.yaml); chmod 600 "$PLAN"
trap 'kill $API_PID $WEB_PID $PROXY_PID 2>/dev/null || true; rm -f "$PLAN"' EXIT
PLAN_OUT="$PLAN" PLAN_IN="$HERE/zap-plan.yaml" node "$HERE/render-plan.mjs"
"$ZAP_HOME/zap.sh" -cmd -port 8099 -autorun "$PLAN" 2>&1 | tee "$REPORT_DIR/zap.log" | grep -E "Job .* (started|finished)|ERROR|WARN" || true
node -e "const r=require('$REPORT_DIR/zap-report.json'); const a=r.site.flatMap(s=>s.alerts); const by={}; for (const x of a) by[x.riskdesc.split(' ')[0]]=(by[x.riskdesc.split(' ')[0]]||0)+1; console.log('alerts by risk:', JSON.stringify(by)); for (const x of a.filter(x=>!/^Informational/.test(x.riskdesc))) console.log(' -', x.riskdesc, '|', x.name, '|', x.count, 'instance(s)')"
node -e "
const rows = require('fs').readFileSync('$REPORT_DIR/api-requests.csv', 'utf8').trim().split('\\n').slice(1).map((l) => l.split(','));
const by = (k) => rows.reduce((m, r) => (m[k(r)] = (m[k(r)] || 0) + 1, m), {});
console.log('API requests from the scan:', rows.length, '| distinct endpoints:', Object.keys(by((r) => r[0] + ' ' + r[1])).length);
console.log('by status:', JSON.stringify(by((r) => r[2])));
console.log('5xx:', rows.filter((r) => r[2].startsWith('5')).map((r) => r[0] + ' ' + r[1]).slice(0, 10).join('; ') || 'none');
"
