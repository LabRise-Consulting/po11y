#!/usr/bin/env bash
# Back up the po11y server's SQLite store — see docs/server.md
# "Backup". The store is its own backup surface: it is NOT
# covered by any pre-existing nightly job (e.g. a Postgres pg_dump), because
# nothing else writes to it. Give it its own schedule.
#
# VACUUM INTO, not `sqlite3 .backup`: the server image ships no sqlite3
# binary, only node:sqlite. Not a plain file copy either: a live WAL makes a
# straight `cp` of the .db file inconsistent — VACUUM INTO always yields a
# clean, single-file snapshot regardless of in-flight writes.
#
# Usage:
#   scripts/backup-store.sh TARGET_DIR [COMPOSE_FILE ...]
#
# TARGET_DIR receives the dated backup (po11y-YYYY-MM-DD.db), created if it
# does not exist. COMPOSE_FILE(s) default to compose's own file discovery
# (docker-compose.yml, the bundled stack); pass the exact files the stack was
# actually brought up with if that differs — e.g. docker-compose.readonly.yml
# for the read-only stack. docker compose derives the running project's name from the
# current directory, not from which -f files you pass, so this only matters
# if you also run from a different directory or set COMPOSE_PROJECT_NAME.
#
# Cron example (daily at 03:00, run from the repo root so the default compose
# file resolves and the running project is found):
#   0 3 * * * cd /path/to/po11y && ./scripts/backup-store.sh /path/to/backups >>/path/to/backups/backup.log 2>&1

set -euo pipefail

usage() {
  echo "usage: $0 TARGET_DIR [COMPOSE_FILE ...]" >&2
  exit 1
}

if [ "$#" -lt 1 ]; then
  usage
fi

target_dir=$1
shift

# Every call site below expands this as ${compose_args[@]+"${compose_args[@]}"},
# never as the obvious "${compose_args[@]}". With no COMPOSE_FILE arguments —
# the DOCUMENTED zero-argument invocation in the cron example above — the array
# is empty, and bash 3.2 (what macOS ships) treats an empty array expansion
# under `set -u` as an unbound variable and aborts. The +-form expands to
# nothing when the array is empty and to its elements otherwise, on both 3.2
# and 4+. shellcheck does not catch this, so do not "simplify" it back.
compose_args=()
for f in "$@"; do
  compose_args+=(-f "$f")
done

mkdir -p "$target_dir"

stamp=$(date +%F)
dest="$target_dir/po11y-$stamp.db"
remote_backup="/data/po11y-backup-$stamp.db"

cleanup() {
  # Best-effort: do not let a cleanup failure mask the real exit status, and
  # do not fail the whole backup if the container is already gone by now.
  docker compose ${compose_args[@]+"${compose_args[@]}"} exec -T server rm -f "$remote_backup" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Remove any same-day leftover first — VACUUM INTO refuses to overwrite an
# existing file, which would otherwise break a re-run on the same date.
docker compose ${compose_args[@]+"${compose_args[@]}"} exec -T server rm -f "$remote_backup"

# The path is passed as a node argv entry (after --), not string-interpolated
# into the JS source, so it never has to be escaped for both shell and JS
# quoting at once. SQLite string literals are single-quoted (a double-quoted
# one is an identifier, and would fail as "no such column"), so the literal
# is built by hand — via String.fromCharCode(39) rather than a literal quote
# character, so this whole script can stay single-quoted in bash without
# fighting its own quoting.
docker compose ${compose_args[@]+"${compose_args[@]}"} exec -T server node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.env.PO11Y_DB || "/data/po11y.db");
  const q = String.fromCharCode(39);
  const literal = q + String(process.argv[1]).split(q).join(q + q) + q;
  db.exec(`VACUUM INTO ${literal}`);
' -- "$remote_backup"

docker compose ${compose_args[@]+"${compose_args[@]}"} cp "server:$remote_backup" "$dest"

echo "backup-store: wrote $dest"
