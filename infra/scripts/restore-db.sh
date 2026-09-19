#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_dir="$(cd -- "${script_dir}/../.." && pwd -P)"
compose_file="${repository_dir}/docker-compose.yml"
project_name="khohang-idosi"
env_file=""
backup_file=""
target_database=""
confirmed_database=""

usage() {
  printf '%s\n' \
    'Usage: restore-db.sh --backup FILE --target-db NAME --confirm-db NAME [options]' \
    '' \
    'The target must be a new database and cannot be the live POSTGRES_DB. This' \
    'allows validation before DATABASE_URL is switched and avoids an in-place restore.' \
    '' \
    'Options:' \
    '  --backup FILE         Custom-format pg_dump archive' \
    '  --target-db NAME      New database to create' \
    '  --confirm-db NAME     Must exactly match --target-db' \
    '  --compose-file PATH   Compose file (default: repository docker-compose.yml)' \
    '  --env-file PATH       Production Compose environment file' \
    '  --project-name NAME   Compose project (default: khohang-idosi)' \
    '  --help                Show this help'
}

fail() {
  printf 'restore-db: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --backup)
      (($# >= 2)) || fail '--backup requires a value'
      backup_file="$2"
      shift 2
      ;;
    --target-db)
      (($# >= 2)) || fail '--target-db requires a value'
      target_database="$2"
      shift 2
      ;;
    --confirm-db)
      (($# >= 2)) || fail '--confirm-db requires a value'
      confirmed_database="$2"
      shift 2
      ;;
    --compose-file)
      (($# >= 2)) || fail '--compose-file requires a value'
      compose_file="$2"
      shift 2
      ;;
    --env-file)
      (($# >= 2)) || fail '--env-file requires a value'
      env_file="$2"
      shift 2
      ;;
    --project-name)
      (($# >= 2)) || fail '--project-name requires a value'
      project_name="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -f "$compose_file" ]] || fail "compose file not found: $compose_file"
[[ -z "$env_file" || (-f "$env_file" && -r "$env_file") ]] || \
  fail "environment file is not readable: $env_file"
[[ -f "$backup_file" && -r "$backup_file" ]] || fail "backup is not readable: $backup_file"
[[ "$target_database" == "$confirmed_database" ]] || fail '--confirm-db must exactly match --target-db'
[[ "$target_database" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || fail 'invalid PostgreSQL database name'
[[ "$target_database" != postgres && "$target_database" != template0 && "$target_database" != template1 ]] || \
  fail 'refusing to restore into a PostgreSQL maintenance database'
[[ "$project_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail 'invalid project name'

compose=(docker compose)
if [[ -n "$env_file" ]]; then
  compose+=(--env-file "$env_file")
fi
compose+=(--file "$compose_file" --project-name "$project_name")
"${compose[@]}" version >/dev/null

live_database="$("${compose[@]}" exec -T db sh -ceu 'printf "%s" "$POSTGRES_DB"')"
[[ "$target_database" != "$live_database" ]] || fail 'refusing an in-place restore into the live POSTGRES_DB'

checksum_file="${backup_file}.sha256"
if [[ -f "$checksum_file" ]]; then
  backup_dir="$(cd -- "$(dirname -- "$backup_file")" && pwd -P)"
  (
    cd -- "$backup_dir"
    sha256sum --check -- "$(basename -- "$checksum_file")"
  )
else
  printf 'Warning: no SHA-256 sidecar found; validating archive structure only.\n' >&2
fi

"${compose[@]}" exec -T db pg_restore --list <"$backup_file" >/dev/null

database_exists="$("${compose[@]}" exec -T db sh -ceu \
  'psql --dbname=postgres --username="$POSTGRES_USER" --tuples-only --no-align --command="SELECT 1 FROM pg_database WHERE datname = '\''$1'\'';"' \
  sh "$target_database")"
[[ -z "$database_exists" ]] || fail "target database already exists: $target_database"

created=false
cleanup() {
  exit_code=$?
  if ((exit_code != 0)) && [[ "$created" == true ]]; then
    printf 'Restore failed; removing the newly created target database %q.\n' "$target_database" >&2
    "${compose[@]}" exec -T db sh -ceu \
      'dropdb --force --if-exists --username="$POSTGRES_USER" "$1"' sh "$target_database" || true
  fi
  return "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" exec -T db sh -ceu \
  'createdb --encoding=UTF8 --template=template0 --username="$POSTGRES_USER" "$1"' sh "$target_database"
created=true

"${compose[@]}" exec -T db sh -ceu \
  'exec pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$1"' \
  sh "$target_database" <"$backup_file"

"${compose[@]}" exec -T db sh -ceu \
  'psql --dbname="$1" --username="$POSTGRES_USER" --set=ON_ERROR_STOP=1 --command="SELECT current_database(), current_timestamp;"' \
  sh "$target_database"

created=false
trap - EXIT INT TERM
printf 'Restore completed into new database %q. Validate it before changing DATABASE_URL.\n' "$target_database"
