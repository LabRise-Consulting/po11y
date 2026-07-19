#!/bin/sh
# Fail if any '# REMOVE AFTER YYYY-MM' marker in bootstrap.sh is in the past.
# These mark dated liabilities (e.g. the schema-coupled RETIRED_IDS deletes) so
# they cannot rot silently. YYYY-MM is stripped to a YYYYMM integer and compared
# numerically — chronological order, no date maths, no dependencies.
set -eu

FILE="${1:-bootstrap.sh}"
NOW="$(date +%Y%m)"
status=0

# Pull the YYYY-MM out of each marker; grep -o keeps only the matched date.
markers="$(grep -oE '# REMOVE AFTER [0-9]{4}-[0-9]{2}' "$FILE" 2>/dev/null \
  | sed 's/.*AFTER //' || true)"

for marker in $markers; do
  num="$(echo "$marker" | tr -d '-')"
  if [ "$num" -lt "$NOW" ]; then
    echo "check-expired-markers: EXPIRED marker '$marker' in $FILE (now $(date +%Y-%m)) — remove the retired entry"
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  exit 1
fi
echo "check-expired-markers: OK — no expired markers in $FILE"
