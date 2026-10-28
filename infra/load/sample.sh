#!/usr/bin/env bash
# Samples CPU (% of one core over each 5 s interval, from /proc deltas: `ps %cpu` would be the
# lifetime average) and RSS of the API, PostgreSQL (all backends), Redis and the S3 server (moto or MinIO) into
# results/resources.csv. Only processes alive in both samples count (connections come and go).
OUT="$(dirname "$0")/results/resources.csv"
HZ=$(getconf CLK_TCK)
echo "time,api_cpu,api_rss_mb,postgres_cpu,redis_cpu,storage_cpu,load1" > "$OUT"
declare -A PREV
RES=0
delta() { # delta NAME PID… → sets RES (ticks)
  local name=$1 p t; shift; RES=0
  declare -A now=()
  for p in "$@"; do
    t=$(awk '{print $14+$15}' "/proc/$p/stat" 2>/dev/null) || continue
    [ -n "$t" ] || continue
    now[$p]=$t
    [ -n "${PREV[$name:$p]:-}" ] && RES=$((RES + t - PREV[$name:$p]))
  done
  for k in "${!PREV[@]}"; do [[ $k == "$name:"* ]] && unset "PREV[$k]"; done
  for p in "${!now[@]}"; do PREV[$name:$p]=${now[$p]}; done
}
pct() { awk -v d="$1" -v hz="$HZ" 'BEGIN {printf "%.0f", d / hz / 5 * 100}'; }
pids_api() { ps -eo pid,args | awk '$2=="node" && $3 ~ /dist\/main\.js$/ {print $1}'; }
sample() { delta api $(pids_api); a=$RES; delta pg $(pgrep -x postgres); g=$RES; delta r $(pgrep -x redis-server); r=$RES; delta m $(pgrep -f "moto_server|minio server"); m=$RES; }
sample
while sleep 5; do
  sample
  rss=$(ps -o rss= -p "$(pids_api | head -1)" 2>/dev/null | awk '{printf "%.0f", $1/1024}')
  echo "$(date +%T),$(pct "$a"),$rss,$(pct "$g"),$(pct "$r"),$(pct "$m"),$(cut -d' ' -f1 /proc/loadavg)" >> "$OUT"
done
