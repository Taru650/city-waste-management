#!/usr/bin/env bash
# Samples CPU (% of one core, averaged over each 5 s interval, from /proc deltas: `ps %cpu` would be
# the lifetime average) and RSS of the API, PostgreSQL (all backends), Redis and moto into
# results/resources.csv.
OUT="$(dirname "$0")/results/resources.csv"
HZ=$(getconf CLK_TCK)
echo "time,api_cpu,api_rss_mb,postgres_cpu,redis_cpu,moto_cpu,load1" > "$OUT"
ticks() { local s=0; for p in "$@"; do [ -r "/proc/$p/stat" ] && s=$((s + $(awk '{print $14+$15}' "/proc/$p/stat"))); done; echo $s; }
pids_api() { ps -eo pid,args | awk '$2=="node" && $3 ~ /dist\/main\.js$/ {print $1}'; }
pids() { pgrep -x "$1" | tr '\n' ' '; }
pids_moto() { pgrep -f moto_server | tr '\n' ' '; }
prev_api=$(ticks $(pids_api)); prev_pg=$(ticks $(pids postgres)); prev_r=$(ticks $(pids redis-server)); prev_m=$(ticks $(pids_moto))
while sleep 5; do
  a=$(ticks $(pids_api)); g=$(ticks $(pids postgres)); r=$(ticks $(pids redis-server)); m=$(ticks $(pids_moto))
  rss=$(ps -o rss= -p "$(pids_api | head -1)" 2>/dev/null | awk '{printf "%.0f", $1/1024}')
  pct() { awk -v d="$1" -v hz="$HZ" 'BEGIN {printf "%.0f", d / hz / 5 * 100}'; }
  echo "$(date +%T),$(pct $((a-prev_api))),$rss,$(pct $((g-prev_pg))),$(pct $((r-prev_r))),$(pct $((m-prev_m))),$(cut -d' ' -f1 /proc/loadavg)" >> "$OUT"
  prev_api=$a; prev_pg=$g; prev_r=$r; prev_m=$m
done
