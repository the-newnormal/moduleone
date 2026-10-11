#!/usr/bin/env bash
# Check migration 0013 (the Diary's retention) the way production gets it: on top of 0012 with a
# privacy-notice acceptance and check-ins pointing at recordings of different ages, one of them at a
# file Storage no longer has. (CI's other checks only build a fresh database, where none of this
# comes up.)
#
# Usage: supabase db reset --version 0012 --no-seed && scripts/check-diary-retention-upgrade.sh
# Everything runs in one transaction that is rolled back, so the database stays at 0012; run
# `supabase db reset` afterwards for the full schema. Needs psql. DB_URL defaults to the local
# Supabase database.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
db_url=${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}
migration=supabase/migrations/0013_diary_retention.sql

latest=$(psql "$db_url" --no-psqlrc -Atc "select max(version) from supabase_migrations.schema_migrations")
if [ "$latest" != 0012 ]; then
  echo "Expected a database at migration 0012, found ${latest:-none}. Run: supabase db reset --version 0012 --no-seed" >&2
  exit 1
fi

psql "$db_url" --no-psqlrc -v ON_ERROR_STOP=1 -q -v migration="$migration" -f scripts/check-diary-retention-upgrade.sql
echo "OK: 0013 keeps every existing recording and acceptance at 90 days, dated from its upload, changing nothing else."
