#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_dir="$(cd -- "${script_dir}/../.." && pwd -P)"
compose_file="${repository_dir}/docker-compose.yml"
project_name="khohang-idosi"
env_file=""
image_source=""
from_tag=""
to_tag=""
confirmed_database_compatibility=false
confirmed_execution=false

usage() {
  printf '%s\n' \
    'Usage: rollback.sh --image-source local|registry --from-tag CURRENT --to-tag PREVIOUS [confirmations] [options]' \
    '' \
    'Required confirmations:' \
    '  --image-source MODE             local or registry' \
    '  --confirm-forward-compatible-db  Confirm the current schema supports PREVIOUS' \
    '  --yes                            Confirm service replacement' \
    '' \
    'This rolls back immutable API, worker, and web images. It never reverses' \
    'migrations and never restores a database automatically.' \
    '' \
    'Options:' \
    '  --compose-file PATH   Compose file (default: repository docker-compose.yml)' \
    '  --env-file PATH       Production Compose environment file' \
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
    --env-file)
      (($# >= 2)) || fail '--env-file requires a value'
      env_file="$2"
      shift 2
      ;;
    --image-source)
      (($# >= 2)) || fail '--image-source requires local or registry'
      image_source="$2"
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
[[ "$image_source" == local || "$image_source" == registry ]] || \
  fail '--image-source must be either local or registry'
[[ "$confirmed_database_compatibility" == true ]] || fail 'database compatibility confirmation is required'
[[ "$confirmed_execution" == true ]] || fail 'pass --yes after reviewing the target tags'
[[ -f "$compose_file" ]] || fail "compose file not found: $compose_file"
[[ -z "$env_file" || (-f "$env_file" && -r "$env_file") ]] || \
  fail "environment file is not readable: $env_file"
[[ "$project_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail 'invalid project name'
compose=(docker compose)
if [[ -n "$env_file" ]]; then
  compose+=(--env-file "$env_file")
fi
compose+=(--file "$compose_file" --project-name "$project_name")
services=(api worker web)
"${compose[@]}" version >/dev/null

resolve_service_image() {
  local tag="$1"
  local service="$2"
  local rendered_images
  local image
  local -a matches=()

  if ! rendered_images="$(IMAGE_TAG="$tag" "${compose[@]}" config --images "$service")"; then
    fail "could not resolve the $service image for tag $tag"
  fi

  while IFS= read -r image; do
    if [[ "$image" == *-"${service}:${tag}" ]]; then
      matches+=("$image")
    fi
  done <<<"$rendered_images"

  ((${#matches[@]} == 1)) || \
    fail "expected exactly one $service image ending in -${service}:${tag}"
  printf '%s\n' "${matches[0]}"
}

verify_tag_images() {
  local tag="$1"
  local service
  local image

  for service in "${services[@]}"; do
    image="$(resolve_service_image "$tag" "$service")"
    docker image inspect "$image" >/dev/null 2>&1 || \
      fail "required image is not available locally: $image"
  done
}

prepare_tag_images() {
  local tag="$1"

  if [[ "$image_source" == registry ]]; then
    printf 'Pulling application images tagged %q from the registry...\n' "$tag"
    IMAGE_TAG="$tag" "${compose[@]}" pull "${services[@]}"
  else
    printf 'Using prebuilt local application images tagged %q...\n' "$tag"
  fi

  verify_tag_images "$tag"
}

# Validate both the rollback target and the automatic recovery tag before any
# running service is replaced. Registry mode pulls both; local mode is fully
# offline and requires both immutable image sets to already exist.
prepare_tag_images "$to_tag"
prepare_tag_images "$from_tag"

printf 'Replacing application services with tag %q...\n' "$to_tag"
if ! IMAGE_TAG="$to_tag" "${compose[@]}" up \
  --detach --no-deps --pull never --wait --wait-timeout 180 "${services[@]}"; then
  printf 'Rollback health check failed; attempting recovery to original tag %q.\n' "$from_tag" >&2
  IMAGE_TAG="$from_tag" "${compose[@]}" up \
    --detach --no-deps --pull never --wait --wait-timeout 180 "${services[@]}" || true
  fail "services did not become healthy on rollback tag $to_tag"
fi

IMAGE_TAG="$to_tag" "${compose[@]}" ps "${services[@]}"
printf 'Application rollback completed at tag %q. Database migrations were not changed.\n' "$to_tag"
