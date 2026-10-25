#!/usr/bin/env bash
# Starts the built API with the load-test environment (foreground). Usage: ./run-api.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
eval "$(node -e "import('$HERE/env.mjs').then(m => { for (const [k,v] of Object.entries(m.apiEnv)) console.log('export '+k+'='+JSON.stringify(v)) })")"
exec node "$HERE/../../apps/api/dist/main.js"
