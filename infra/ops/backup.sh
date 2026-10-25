#!/usr/bin/env bash
# Logical backup of the database: pg_dump custom format (consistent snapshot, safe while the app
# runs), SHA-256 alongside, optional AES-256 encryption with a key file from the vault.
#   DATABASE_URL=postgres://… BACKUP_DIR=/backups [BACKUP_KEY_FILE=/run/secrets/backup.key] ./backup.sh
# This complements, not replaces, the managed database's point-in-time recovery (WAL archiving):
# PITR covers "restore to 10:42 yesterday"; this covers "restore anywhere, even another provider".
# Mobile numbers, emails and TOTP secrets are encrypted in the database with keys that are NOT in
# the dump; names, complaint texts and locations are not, so the file must be protected.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$DIR/cwm-$STAMP.dump"
start=$(date +%s)
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$FILE"
if [ -n "${BACKUP_KEY_FILE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$FILE" -out "$FILE.enc" -pass "file:$BACKUP_KEY_FILE"
  shred -u "$FILE" 2>/dev/null || rm -f "$FILE"
  FILE="$FILE.enc"
fi
sha256sum "$FILE" > "$FILE.sha256"
echo "backup: $FILE ($(du -h "$FILE" | cut -f1), $(( $(date +%s) - start )) s)"
