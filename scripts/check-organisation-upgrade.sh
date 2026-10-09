#!/usr/bin/env bash
# Check migration 0006 (the organisation node) the way production gets it: on top of 0005 with
# the founding divisions, people sitting in a division (one of them as a member, which 0005
# allowed), an archived division, a division lead row, an unplaced domain and check-ins. (CI's
# other checks only build a fresh database, where none of this comes up.)
#
# Usage: supabase db reset --version 0005 --no-seed && scripts/check-organisation-upgrade.sh
# Everything runs in one transaction that is rolled back, so the database stays at 0005; run
# `supabase db reset` afterwards for the full schema. Needs psql. DB_URL defaults to the local
# Supabase database.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
db_url=${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}
migration=supabase/migrations/0006_organisation.sql

latest=$(psql "$db_url" --no-psqlrc -Atc "select max(version) from supabase_migrations.schema_migrations")
if [ "$latest" != 0005 ]; then
  echo "Expected a database at migration 0005, found ${latest:-none}. Run: supabase db reset --version 0005 --no-seed" >&2
  exit 1
fi

psql "$db_url" --no-psqlrc -v ON_ERROR_STOP=1 -q -v migration="$migration" -f scripts/check-organisation-upgrade.sql
echo "OK: 0006 puts every division under the organisation and makes the members sitting in a division its leaders, changing nothing else."
