#!/usr/bin/env bash
# Runs the Dart mobile client against the real API (PostgreSQL/PostGIS, Redis, S3 via moto).
# Reuses the portal e2e seed (apps/web/e2e/prepare.mjs). Requires: apps/api built, apps/web deps installed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT=3110
cd "$ROOT/apps/web"
node e2e/prepare.mjs
ENV_JSON=$(node -e "import('./e2e/env.mjs').then(m => console.log(JSON.stringify({...m.apiEnv, PORT: '$PORT'})))")
eval "$(node -e "const e=$ENV_JSON; for (const [k,v] of Object.entries(e)) console.log('export '+k+'='+JSON.stringify(v))")"
# Fake Google Play Integrity, so the API runs with attestation enforced exactly as in production.
PI_ENV=$(mktemp)
rm -f "$PI_ENV"
(cd "$ROOT/apps/api" && exec npx ts-node --transpile-only test/fake-play-integrity-server.ts "$PI_ENV") > /tmp/cwm-contract-pi.log 2>&1 &
PI_PID=$!
trap 'kill $PI_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do [ -s "$PI_ENV" ] && break; sleep 0.5; done
[ -s "$PI_ENV" ] || { echo "fake Play Integrity did not start, see /tmp/cwm-contract-pi.log" >&2; exit 1; }
PI_EXPORTS=$(node -e "const e=JSON.parse(require('fs').readFileSync('$PI_ENV','utf8')); for (const [k,v] of Object.entries(e)) console.log('export '+k+'='+JSON.stringify(v))")
eval "$PI_EXPORTS"
[ "${PLAY_INTEGRITY_MODE:-}" = enforce ] || { echo "PLAY_INTEGRITY_MODE not exported" >&2; exit 1; }
node "$ROOT/apps/api/dist/main.js" > /tmp/cwm-contract-api.log 2>&1 &
API_PID=$!
trap 'kill $API_PID $PI_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/v1/health/ready" >/dev/null && break; sleep 0.5; done
cd "$ROOT/packages/flutter_core"
flutter test test/contract \
  --dart-define=CONTRACT_API="http://127.0.0.1:$PORT/api/v1" \
  --dart-define=CONTRACT_FIXTURES="$ROOT/apps/web/e2e/.auth/fixtures.json" "$@"
