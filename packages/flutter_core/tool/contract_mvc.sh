#!/usr/bin/env bash
# Runs the Dart mobile client against the Next.js + MySQL API (apps/mvc-app).
# Needs: MySQL running with the cwm_mvc_e2e database (see apps/mvc-app/README.md), apps/mvc-app built (npm run build).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT=3110
APP="$ROOT/apps/mvc-app"
cd "$APP"
node e2e/prepare.mjs                      # rebuilds the throwaway e2e database with the demo data
FIXTURES=$(mktemp)
node e2e/contract-fixtures.mjs "$FIXTURES"
eval "$(node -e "import('./e2e/env.mjs').then(m => { const e = {...m.appEnv, APP_URL: 'http://127.0.0.1:$PORT'}; for (const [k,v] of Object.entries(e)) console.log('export '+k+'='+JSON.stringify(v)) })")"
npx next start -p "$PORT" > /tmp/cwm-contract-mvc.log 2>&1 &
APP_PID=$!
trap 'pkill -P $APP_PID 2>/dev/null || true; kill $APP_PID 2>/dev/null || true; fuser -k $PORT/tcp >/dev/null 2>&1 || true; rm -f "$FIXTURES"' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/v1/health/ready" >/dev/null && break; sleep 0.5; done
cd "$ROOT/packages/flutter_core"
flutter test test/contract_mvc \
  --dart-define=CONTRACT_API="http://127.0.0.1:$PORT/api/v1" \
  --dart-define=CONTRACT_FIXTURES="$FIXTURES" "$@"
