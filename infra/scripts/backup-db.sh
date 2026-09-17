#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_dir="$(cd -- "${script_dir}/../.." && pwd -P)"
compose_file="${repository_dir}/docker-compose.yml"
project_name="khohang-idosi"
env_file=""
output_dir=""

usage() {
  printf '%s\n' \
    'Usage: backup-db.sh --output-dir ABSOLUTE_PATH [options]' \
    '' \
    'Options:' \
    '  --compose-file PATH   Compose file (default: repository docker-compose.yml)' \
    '  --env-file PATH       Production Compose environment file' \
    '  --project-name NAME   Compose project (default: khohang-idosi)' \
    '  --output-dir PATH     Existing or creatable absolute backup directory' \
    '  --help                Show this help'
}

fail() {
  printf 'backup-db: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
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
    --output-dir)
      (($# >= 2)) || fail '--output-dir requires a value'
      output_dir="$2"
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
[[ -n "$output_dir" ]] || fail '--output-dir is required'
[[ "$output_dir" = /* ]] || fail '--output-dir must be an absolute path'
[[ "$output_dir" != / ]] || fail 'refusing to use the filesystem root as output directory'
[[ "$project_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail 'invalid project name'

mkdir -p -- "$output_dir"
[[ -d "$output_dir" && -w "$output_dir" ]] || fail "output directory is not writable: $output_dir"

compose=(docker compose)
if [[ -n "$env_file" ]]; then
  compose+=(--env-file "$env_file")
fi
compose+=(--file "$compose_file" --project-name "$project_name")
"${compose[@]}" version >/dev/null

db_running=false
while IFS= read -r service; do
  if [[ "$service" == db ]]; then
    db_running=true
    break
  fi
done < <("${compose[@]}" ps --status running --services)
[[ "$db_running" == true ]] || fail 'the db service is not running'

database_name="$("${compose[@]}" exec -T db sh -ceu 'printf "%s" "$POSTGRES_DB"')"
[[ -n "$database_name" ]] || fail 'POSTGRES_DB is empty inside the db service'

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
filename="idosi-${timestamp}.dump"
final_path="${output_dir}/${filename}"
checksum_path="${final_path}.sha256"

[[ ! -e "$final_path" && ! -e "$checksum_path" ]] || fail "backup already exists: $final_path"

temporary_path="$(mktemp "${output_dir}/.idosi-backup.XXXXXX.dump")"
temporary_checksum="${output_dir}/.${filename}.sha256.tmp"
cleanup() {
  rm -f -- "$temporary_path" "$temporary_checksum"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Creating a consistent custom-format backup of database %q...\n' "$database_name"
"${compose[@]}" exec -T db sh -ceu \
  'exec pg_dump --format=custom --compress=9 --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  >"$temporary_path"

[[ -s "$temporary_path" ]] || fail 'pg_dump produced an empty backup'
"${compose[@]}" exec -T db pg_restore --list <"$temporary_path" >/dev/null

mv -- "$temporary_path" "$final_path"
(
  cd -- "$output_dir"
  sha256sum -- "$filename" >".${filename}.sha256.tmp"
)
mv -- "$temporary_checksum" "$checksum_path"

trap - EXIT INT TERM
printf 'Verified backup: %s\nChecksum: %s\n' "$final_path" "$checksum_path"
