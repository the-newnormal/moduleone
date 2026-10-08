#!/usr/bin/env bash
# Check migration 0003 (the team tree) the way production gets it: on top of teams, members and
# check-ins made under 0001+0002, including a hand-made team named like a founding division. Also
# checks that 0003's founding load is safe to run again. (CI's other checks only build a fresh
# database, where none of this comes up.)
#
# Usage: supabase db reset --version 0002 --no-seed && scripts/check-team-tree-upgrade.sh
# Everything runs in one transaction that is rolled back, so the database stays at 0002; run
# `supabase db reset` afterwards for the full schema. Needs psql. DB_URL defaults to the local
# Supabase database.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
db_url=${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}
migration=supabase/migrations/0003_team_tree.sql
marker='-- ---------- founding structure ----------'

latest=$(psql "$db_url" --no-psqlrc -Atc "select max(version) from supabase_migrations.schema_migrations")
if [ "$latest" != 0002 ]; then
  echo "Expected a database at migration 0002, found ${latest:-none}. Run: supabase db reset --version 0002 --no-seed" >&2
  exit 1
fi

# The founding load is the end of 0003, from the marker line on.
grep -qxF -- "$marker" "$migration" || { echo "$migration has no line: $marker" >&2; exit 1; }
founding=$(mktemp)
trap 'rm -f "$founding"' EXIT
awk -v m="$marker" '$0 == m { on = 1 } on' "$migration" > "$founding"

psql "$db_url" --no-psqlrc -v ON_ERROR_STOP=1 -q \
  -v migration="$migration" -v founding="$founding" -f scripts/check-team-tree-upgrade.sql
echo "OK: 0003 applies on top of existing teams, members and check-ins, and its founding load can run again."
