#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_dir="$(cd -- "${script_dir}/../.." && pwd -P)"
compose_file="${repository_dir}/docker-compose.yml"
project_name="khohang-idosi"
from_tag=""
to_tag=""
confirmed_database_compatibility=false
confirmed_execution=false

usage() {
  printf '%s\n' \
    'Usage: rollback.sh --from-tag CURRENT --to-tag PREVIOUS [confirmations] [options]' \
    '' \
    'Required confirmations:' \
    '  --confirm-forward-compatible-db  Confirm the current schema supports PREVIOUS' \
    '  --yes                            Confirm service replacement' \
    '' \
    'This rolls back immutable API, worker, and web images. It never reverses' \
    'migrations and never restores a database automatically.' \
    '' \
    'Options:' \
    '  --compose-file PATH   Compose file (default: repository docker-compose.yml)' \
    '  --project-name NAME   Compose project (default: khohang-idosi)' \
    '  --from-tag TAG        Currently deployed commit tag; used for automatic recovery' \
    '  --to-tag TAG          Previously verified commit tag' \
    '  --help                Show this help'
}

fail() {
  printf 'rollback: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --compose-file)
      (($# >= 2)) || fail '--compose-file requires a value'
      compose_file="$2"
      shift 2
      ;;
    --project-name)
      (($# >= 2)) || fail '--project-name requires a value'
      project_name="$2"
      shift 2
      ;;
    --from-tag)
      (($# >= 2)) || fail '--from-tag requires a value'
      from_tag="$2"
      shift 2
      ;;
    --to-tag)
      (($# >= 2)) || fail '--to-tag requires a value'
      to_tag="$2"
      shift 2
      ;;
    --confirm-forward-compatible-db)
      confirmed_database_compatibility=true
      shift
      ;;
    --yes)
      confirmed_execution=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

tag_pattern='^([0-9a-f]{40}|[0-9a-f]{64})$'
[[ "$from_tag" =~ $tag_pattern ]] || fail '--from-tag must be a full 40- or 64-character commit SHA'
[[ "$to_tag" =~ $tag_pattern ]] || fail '--to-tag must be a full 40- or 64-character commit SHA'
[[ "$from_tag" != "$to_tag" ]] || fail '--from-tag and --to-tag must differ'
[[ "$confirmed_database_compatibility" == true ]] || fail 'database compatibility confirmation is required'
[[ "$confirmed_execution" == true ]] || fail 'pass --yes after reviewing the target tags'
[[ -f "$compose_file" ]] || fail "compose file not found: $compose_file"
[[ "$project_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail 'invalid project name'
compose=(docker compose --file "$compose_file" --project-name "$project_name")
services=(api worker web)
"${compose[@]}" version >/dev/null

printf 'Pulling rollback images tagged %q...\n' "$to_tag"
IMAGE_TAG="$to_tag" "${compose[@]}" pull "${services[@]}"

printf 'Replacing application services with tag %q...\n' "$to_tag"
if ! IMAGE_TAG="$to_tag" "${compose[@]}" up \
  --detach --no-deps --wait --wait-timeout 180 "${services[@]}"; then
  printf 'Rollback health check failed; attempting recovery to original tag %q.\n' "$from_tag" >&2
  IMAGE_TAG="$from_tag" "${compose[@]}" pull "${services[@]}" || true
  IMAGE_TAG="$from_tag" "${compose[@]}" up \
    --detach --no-deps --wait --wait-timeout 180 "${services[@]}" || true
  fail "services did not become healthy on rollback tag $to_tag"
fi

IMAGE_TAG="$to_tag" "${compose[@]}" ps "${services[@]}"
printf 'Application rollback completed at tag %q. Database migrations were not changed.\n' "$to_tag"
