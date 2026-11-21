#!/usr/bin/env bash
# Finds a working Postgres connection for the Supabase project and exports
# PGHOST/PGPORT/PGUSER/PGDATABASE to later steps. Needs PGPASSWORD set from
# the SUPABASE_DB_PASSWORD secret. GitHub runners have no IPv6, so the direct
# db.<ref>.supabase.co host usually fails and the session pooler is used.
set -euo pipefail
REF="${SUPABASE_PROJECT_REF:?}"
: "${PGPASSWORD:?SUPABASE_DB_PASSWORD secret is missing}"
export PGDATABASE=postgres PGPORT=5432 PGCONNECT_TIMEOUT=8 PGSSLMODE=require

try() {
  PGHOST="$1" PGUSER="$2" psql -Atqc 'select 1' >/dev/null 2>&1
}

found=""
if try "db.$REF.supabase.co" postgres; then
  found="db.$REF.supabase.co postgres"
else
  regions="us-east-1 us-east-2 us-west-1 us-west-2 ca-central-1 sa-east-1 eu-west-1 eu-west-2 eu-west-3 eu-central-1 eu-central-2 eu-north-1 ap-south-1 ap-southeast-1 ap-southeast-2 ap-northeast-1 ap-northeast-2"
  for prefix in aws-0 aws-1; do
    for r in $regions; do
      if try "$prefix-$r.pooler.supabase.com" "postgres.$REF"; then
        found="$prefix-$r.pooler.supabase.com postgres.$REF"; break 2
      fi
    done
  done
fi

if [ -z "$found" ]; then
  echo "Could not connect to the Supabase database. Check the SUPABASE_DB_PASSWORD secret." >&2
  exit 1
fi
read -r host user <<<"$found"
echo "Connected through $host"
{
  echo "PGHOST=$host"; echo "PGUSER=$user"; echo "PGPORT=5432"
  echo "PGDATABASE=postgres"; echo "PGSSLMODE=require"
} >> "${GITHUB_ENV:-/dev/null}"
