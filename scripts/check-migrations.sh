#!/usr/bin/env bash
# Check a local database that `supabase db start` (or `supabase db reset`) just
# built from supabase/migrations/. Fails if:
#   - a migration file was not applied (the CLI skips, with only a warning, any
#     file not named <version>_<name>.sql)
#   - a table has row level security off (CLAUDE.md: RLS on every table).
#     Schemas the Supabase stack itself owns are skipped.
#
# Usage: supabase db start && scripts/check-migrations.sh
# Needs psql. DB_URL defaults to the local Supabase database.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
db_url=${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}
sql() { psql "$db_url" --no-psqlrc -v ON_ERROR_STOP=1 -Atc "$1"; }
files=$(cd supabase/migrations && printf '%s\n' *.sql | LC_ALL=C sort)
status=0

not_applied=$(LC_ALL=C comm -23 <(echo "$files") \
  <(sql "select version || '_' || name || '.sql' from supabase_migrations.schema_migrations" | LC_ALL=C sort))
if [ -n "$not_applied" ]; then
  echo "Not applied (names must be <version>_<name>.sql; after adding one locally, run supabase db reset):" >&2
  sed 's|^|  supabase/migrations/|' <<<"$not_applied" >&2
  status=1
fi

no_rls=$(sql "
  select format('%I.%I', n.nspname, c.relname)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and not c.relrowsecurity
    and n.nspname not like 'pg\_%'
    and n.nspname not in ('information_schema',
      'auth', 'storage', 'realtime', '_realtime', 'vault',
      'supabase_functions', 'supabase_migrations')
  order by 1")
if [ -n "$no_rls" ]; then
  echo "Row level security is off (add: alter table <name> enable row level security;):" >&2
  sed 's/^/  /' <<<"$no_rls" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "OK: $(wc -l <<<"$files") migration(s) applied; RLS is on for every table."
fi
exit "$status"
