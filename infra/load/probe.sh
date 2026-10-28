#!/usr/bin/env bash
# Latency-over-time probe for soak runs: times a supervisor's inbox query and the complaint count
# every 15 s (k6 only reports whole-run percentiles). Writes results/probe.csv.
HERE="$(cd "$(dirname "$0")" && pwd)"
API=http://127.0.0.1:3300/api/v1
MOBILE=$(node -e "console.log(require('$HERE/fixtures.json').supervisors[0].mobile)")
PASS=$(node -e "console.log(require('$HERE/fixtures.json').password)")
OUT="$HERE/results/probe.csv"
echo "time,inbox_ms,complaints" > "$OUT"
token=""; at=0
while true; do
  now=$(date +%s)
  if [ -z "$token" ] || [ $((now - at)) -gt 600 ]; then
    token=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' -d "{\"identifier\":\"$MOBILE\",\"password\":\"$PASS\"}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).accessToken)}catch{console.log('')}})")
    at=$now
  fi
  ms=$(curl -s -o /dev/null -w '%{time_total}' -H "authorization: Bearer $token" "$API/complaints?status=ASSIGNED&pageSize=50" | awk '{printf "%.0f", $1*1000}')
  n=$(PGPASSWORD=postgres psql -h localhost -U postgres -d cwm_load_test -tAc "SELECT count(*) FROM complaints" 2>/dev/null)
  echo "$(date +%T),$ms,$n" >> "$OUT"
  sleep 15
done
