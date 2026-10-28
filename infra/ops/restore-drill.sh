#!/usr/bin/env bash
# Restore drill: restores a backup into a fresh, throwaway database and proves it is usable.
#   ADMIN_URL=postgres://postgres:…@host:5432/postgres ./restore-drill.sh /backups/cwm-….dump[.enc] [BACKUP_KEY_FILE]
# Checks: checksum, restore time (RTO), all migrations present, append-only protections intact,
# complaint numbering continues without collisions, row counts. Exit code ≠ 0 on any failure.
set -euo pipefail
FILE="${1:?backup file}"
KEY="${2:-${BACKUP_KEY_FILE:-}}"
: "${ADMIN_URL:?set ADMIN_URL (a role that can create databases)}"
DB="cwm_restore_drill_$(date +%s)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${KEEP:-}" ] || psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

sha256sum -c "$FILE.sha256" >/dev/null || fail "checksum mismatch"
DUMP="$FILE"
if [[ "$FILE" == *.enc ]]; then
  [ -n "$KEY" ] || fail "encrypted backup: pass the key file"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$FILE" -out "$TMP/db.dump" -pass "file:$KEY"
  DUMP="$TMP/db.dump"
fi
start=$(date +%s)
psql "$ADMIN_URL" -qc "CREATE DATABASE $DB" >/dev/null
TARGET="${ADMIN_URL%/*}/$DB"
psql "$TARGET" -qc "CREATE EXTENSION IF NOT EXISTS postgis" >/dev/null
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET" "$DUMP" 2> "$TMP/restore.log" || { cat "$TMP/restore.log"; fail "pg_restore"; }
rto=$(( $(date +%s) - start ))
q() { psql "$TARGET" -tAqc "$1"; }

# Migrations: an older backup is fine (apply the pending ones after restoring); a backup with
# migrations this code does not know means restoring onto an older release, which is not.
CODE_MIGRATIONS=$(ls "$(dirname "$0")/../../apps/api/src/database/migrations"/*.ts | sed -E 's#.*/([0-9]+)-(.*)\.ts#\2\1#')
restored=$(q "SELECT name FROM schema_migrations ORDER BY name")
unknown=$(comm -23 <(echo "$restored" | sort) <(echo "$CODE_MIGRATIONS" | sort))
[ -z "$unknown" ] || fail "backup has migrations this release does not know: $unknown"
pending=$(comm -13 <(echo "$restored" | sort) <(echo "$CODE_MIGRATIONS" | sort) | grep -c . || true)
for t in complaint_events audit_logs feedback; do
  [ "$(q "SELECT count(*) FROM pg_trigger WHERE tgname = '${t}_append_only'")" = 1 ] || fail "append-only trigger missing on $t"
done
# Numbering: every ULB/year counter must be at or above the highest number issued, or the first
# complaint after a restore would collide (or worse, reuse a citizen's complaint number).
behind=$(q "SELECT count(*) FROM (
  SELECT c.ulb_id, substr(c.complaint_no, 11, 2) AS yy, max(substr(c.complaint_no, 13)::int) AS hi
    FROM complaints c GROUP BY 1, 2) m
  JOIN complaint_seq s ON s.ulb_id = m.ulb_id AND s.year % 100 = m.yy::int
 WHERE s.last_value < m.hi")
[ "$behind" = 0 ] || fail "$behind complaint sequences are behind issued numbers"
counts=$(q "SELECT 'users=' || (SELECT count(*) FROM users) || ' complaints=' || (SELECT count(*) FROM complaints) ||
               ' media=' || (SELECT count(*) FROM complaint_media) || ' events=' || (SELECT count(*) FROM complaint_events) ||
               ' audit=' || (SELECT count(*) FROM audit_logs)")
echo "restore drill OK: $counts; restore took ${rto}s; $pending migration(s) to apply after restore; numbering consistent"
