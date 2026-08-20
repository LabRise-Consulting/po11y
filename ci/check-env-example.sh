#!/bin/sh
# .env.example is one file describing two stacks, so the same variable can
# plausibly be documented in two sections — and twice it was, as two
# assignments rather than one assignment and a cross-reference.
#
# That is never harmless. Compose reads an env file last-wins, while
# scripts/readonly-preflight.sh's get_env reads it first-wins, so a duplicated
# key means the operator's value is honoured by one consumer and silently
# dropped by the other. N8N_PUBLIC_URL was declared twice this way: setting it
# in the section a read-only operator reads left compose using the other,
# empty one.
#
# The fix is a cross-reference, not a second assignment ("Reuses from above:
# BIND_ADDR, ..."). This asserts that stays true.
#
# Usage: sh ci/check-env-example.sh   (from the repo root)
set -eu

fail() { echo "check-env-example: $1" >&2; exit 1; }

FILE=.env.example
[ -f "$FILE" ] || fail "$FILE not found — run from the repo root"

# Assignment lines only: KEY=..., no leading whitespace, no comment.
dupes=$(grep '^[A-Za-z_][A-Za-z0-9_]*=' "$FILE" \
  | sed 's/=.*//' \
  | sort \
  | uniq -d)

if [ -n "$dupes" ]; then
  echo "check-env-example: these variables are assigned more than once in $FILE:" >&2
  printf '%s\n' "$dupes" | sed 's/^/  /' >&2
  echo "  keep one assignment; reference it from the other section in a comment" >&2
  exit 1
fi

echo 'check-env-example: ok'
