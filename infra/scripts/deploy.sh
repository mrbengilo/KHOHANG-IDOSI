#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

# Deploys one merged commit that is already checked out at
# <root>/releases/<sha>. The running services are only replaced after a
# verified backup, a successful image build and a successful migration; any
# failure after replacement restores the previous immutable images. The
# environment file and the `current` symlink change only after every health
# check passes, so they always describe a verified release.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
release_dir="$(cd -- "${script_dir}/../.." && pwd -P)"
root_dir="/opt/khohang-idosi"
env_file="/etc/khohang-idosi/production.env"
backup_dir="/var/backups/khohang-idosi"
lock_file="/run/lock/khohang-idosi-deploy.lock"
project_name="khohang-idosi"
keep_releases=5
min_free_gb=3
release_sha=""
confirmed_execution=false

usage() {
  printf '%s\n' \
    'Usage: deploy.sh --sha FULL_COMMIT_SHA --yes [options]' \
    '' \
    'Run from the release checkout <root>/releases/<sha>.' \
    '' \
    'Options:' \
    '  --sha SHA             Full 40-character commit SHA of this checkout' \
    '  --yes                 Confirm production service replacement' \
    '  --root PATH           Deployment root (default: /opt/khohang-idosi)' \
    '  --env-file PATH       Production environment file' \
    '  --backup-dir PATH     Database backup directory' \
    '  --lock-file PATH      Lock shared by every deployment' \
    '  --keep-releases N     Recent releases whose images are kept (default: 5)' \
    '  --min-free-gb N       Minimum free disk space before building (default: 3)' \
    '  --help                Show this help'
}

log() {
  printf '== %s %s\n' "$(date -Is)" "$*"
}

fail() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --sha | --root | --env-file | --backup-dir | --lock-file | --keep-releases | --min-free-gb)
      (($# >= 2)) || fail "$1 requires a value"
      case "$1" in
        --sha) release_sha="$2" ;;
        --root) root_dir="$2" ;;
        --env-file) env_file="$2" ;;
        --backup-dir) backup_dir="$2" ;;
        --lock-file) lock_file="$2" ;;
        --keep-releases) keep_releases="$2" ;;
        --min-free-gb) min_free_gb="$2" ;;
      esac
      shift 2
      ;;
    --yes)
      confirmed_execution=true
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

sha_pattern='^[0-9a-f]{40}$'
[[ "$release_sha" =~ $sha_pattern ]] || fail '--sha must be a full 40-character commit SHA'
[[ "$confirmed_execution" == true ]] || fail 'pass --yes to confirm production deployment'
[[ -f "$env_file" && -r "$env_file" ]] || fail "environment file is not readable: $env_file"
[[ "$keep_releases" =~ ^[1-9][0-9]*$ ]] || fail '--keep-releases must be a positive integer'
[[ "$min_free_gb" =~ ^[0-9]+$ ]] || fail '--min-free-gb must be a non-negative integer'
[[ -d "$root_dir/releases" ]] || fail "release directory not found: $root_dir/releases"

exec 9>"$lock_file"
flock -n 9 || fail "another deployment is running (lock: $lock_file)"

expected_release="$(cd -- "$root_dir/releases" && pwd -P)/${release_sha}"
[[ "$release_dir" == "$expected_release" ]] || \
  fail "run this script from ${expected_release}, not ${release_dir}"
[[ "$(git -C "$release_dir" rev-parse HEAD)" == "$release_sha" ]] || \
  fail 'release checkout HEAD does not match --sha'
[[ -z "$(git -C "$release_dir" status --porcelain)" ]] || fail 'release checkout has uncommitted changes'

# The release is a checkout of the public repository and holds no secrets, but the watcher
# creates it under umask 077. Image builds copy these files for the non-root `node` user and
# Caddy (uid 65532) reads the bind-mounted Caddyfile, so both must be able to read them.
chmod -R u+rwX,go+rX,go-w -- "$release_dir"

previous_release="$(readlink -f -- "$root_dir/current")" || fail "missing symlink: $root_dir/current"
previous_sha="$(basename -- "$previous_release")"
[[ "$previous_sha" =~ $sha_pattern && -f "$previous_release/docker-compose.yml" ]] || \
  fail "current release is not a valid release directory: $previous_release"
if [[ "$previous_sha" == "$release_sha" ]]; then
  log "release $release_sha is already running"
  exit 0
fi

env_value() {
  sed -n "s/^$1=//p" "$env_file" | tail -n 1 | tr -d "\"'"
}
app_domain="$(env_value APP_DOMAIN)"
image_prefix="$(env_value IMAGE_PREFIX)"
running_tag="$(env_value IMAGE_TAG)"
[[ -n "$app_domain" ]] || fail 'APP_DOMAIN is missing from the environment file'
[[ -n "$image_prefix" ]] || fail 'IMAGE_PREFIX is missing from the environment file'
[[ "$running_tag" == "$previous_sha" ]] || \
  fail "IMAGE_TAG ($running_tag) does not match the current release ($previous_sha)"

docker_root=/var/lib/docker
[[ -d "$docker_root" ]] || docker_root=/
free_kb="$(df -Pk -- "$docker_root" | awk 'NR == 2 { print $4 }')"
((free_kb >= min_free_gb * 1024 * 1024)) || \
  fail "only $((free_kb / 1024 / 1024)) GB free on $docker_root; at least ${min_free_gb} GB is required"

# IMAGE_TAG from the shell overrides the environment file, so the new release
# can be built and started while the file still names the verified release.
new_compose=(docker compose --env-file "$env_file" --file "$release_dir/docker-compose.yml"
  --project-name "$project_name")
old_compose=(docker compose --env-file "$env_file" --file "$previous_release/docker-compose.yml"
  --project-name "$project_name")
stage=preflight
services_replaced=false

on_error() {
  local status=$?
  trap - ERR
  printf 'deploy: FAILED at stage=%s (exit %s)\n' "$stage" "$status" >&2
  if [[ "$services_replaced" != true ]]; then
    printf 'deploy: running services were not replaced; %s is still live\n' "$previous_sha" >&2
    exit "$status"
  fi

  local rollback_script="$previous_release/infra/scripts/rollback.sh"
  [[ -f "$rollback_script" ]] || rollback_script="$release_dir/infra/scripts/rollback.sh"
  printf 'deploy: restoring previous release %s\n' "$previous_sha" >&2
  if bash "$rollback_script" \
    --env-file "$env_file" \
    --compose-file "$previous_release/docker-compose.yml" \
    --project-name "$project_name" \
    --image-source local \
    --from-tag "$release_sha" \
    --to-tag "$previous_sha" \
    --confirm-forward-compatible-db \
    --yes; then
    IMAGE_TAG="$previous_sha" "${old_compose[@]}" up \
      --detach --no-deps --pull never --wait --wait-timeout 180 caddy || \
      printf 'deploy: warning: caddy could not be restarted from the previous release\n' >&2
    printf 'deploy: previous release %s restored; database migrations were kept\n' "$previous_sha" >&2
  else
    printf 'deploy: ROLLBACK FAILED; manual intervention is required\n' >&2
  fi
  exit "$status"
}
trap on_error ERR

log "deploying $release_sha (currently $previous_sha) to $app_domain"
IMAGE_TAG="$release_sha" "${new_compose[@]}" config --quiet

stage=backup
log 'backing up the database'
"$release_dir/infra/scripts/backup-db.sh" --env-file "$env_file" --output-dir "$backup_dir"

stage=build
log 'pulling third-party images and building application images'
IMAGE_TAG="$release_sha" "${new_compose[@]}" pull db caddy caddy-storage-init
IMAGE_TAG="$release_sha" "${new_compose[@]}" build --pull api migrate worker web
for service in api migrate worker web; do
  docker image inspect "${image_prefix}-${service}:${release_sha}" >/dev/null
done

stage=migrate
log 'running database migrations'
IMAGE_TAG="$release_sha" "${new_compose[@]}" up --detach --pull never --wait db
IMAGE_TAG="$release_sha" "${new_compose[@]}" run --rm --no-deps --pull never migrate

stage=switch
log 'replacing api, worker, web and caddy'
services_replaced=true
IMAGE_TAG="$release_sha" "${new_compose[@]}" up \
  --detach --pull never --wait --wait-timeout 180 api worker web caddy

stage=verify
log "verifying https://$app_domain"
for path in health ready; do
  curl --fail --silent --show-error --retry 5 --retry-delay 3 --retry-all-errors \
    "https://${app_domain}/${path}"
  printf ' <- /%s\n' "$path"
done
curl --fail --silent --show-error --retry 3 --retry-delay 2 --retry-all-errors \
  --output /dev/null "https://${app_domain}/openapi.json"
curl --fail --silent --show-error --retry 3 --retry-delay 2 --retry-all-errors \
  --output /dev/null "https://${app_domain}/"

stage=finalize
env_tmp="$(mktemp "${env_file}.XXXXXX")"
sed "s/^IMAGE_TAG=.*/IMAGE_TAG=${release_sha}/" "$env_file" >"$env_tmp"
chmod --reference="$env_file" -- "$env_tmp"
mv -f -- "$env_tmp" "$env_file"
ln -sfn -- "$release_dir" "$root_dir/current.next"
mv -Tf -- "$root_dir/current.next" "$root_dir/current"
printf '%s %s\n' "$(date -Is)" "$release_sha" >>"$root_dir/deploy-history"
trap - ERR

IMAGE_TAG="$release_sha" "${new_compose[@]}" ps
log "RELEASE_OK=$release_sha"

# Cleanup never changes the deployment result.
prune_old_releases() {
  local -A keep=(["$release_sha"]=1 ["$previous_sha"]=1)
  local _date sha image tag dir gitdir mirror removed=0
  while read -r _date sha; do
    [[ "$sha" =~ $sha_pattern ]] && keep["$sha"]=1
  done < <(tail -n "$keep_releases" "$root_dir/deploy-history")

  while IFS= read -r image; do
    tag="${image##*:}"
    [[ -n "${keep[$tag]:-}" ]] && continue
    docker image rm "$image" >/dev/null 2>&1 && removed=$((removed + 1))
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' |
    grep -E "^${image_prefix//./\\.}-[a-z-]+:[0-9a-f]{40}$" || true)
  log "removed $removed old application images"
  docker builder prune --force --filter until=168h >/dev/null 2>&1 || true

  # Only checkouts created from the deployment mirror are removed; older
  # standalone checkouts are left for an operator to review.
  mirror="$root_dir/repo.git"
  [[ -d "$mirror" ]] || return 0
  mirror="$(cd -- "$mirror" && pwd -P)"
  for dir in "$root_dir"/releases/*; do
    sha="$(basename -- "$dir")"
    [[ "$sha" =~ $sha_pattern && -z "${keep[$sha]:-}" && -f "$dir/.git" ]] || continue
    gitdir="$(sed -n 's/^gitdir: //p' "$dir/.git")"
    [[ "$gitdir" == "$mirror/worktrees/"* ]] || continue
    git --git-dir="$mirror" worktree remove --force "$dir" && log "removed release $sha"
  done
  git --git-dir="$mirror" worktree prune
}
prune_old_releases || log 'warning: cleanup of old releases failed'

# Keep the installed auto-deploy watcher in step with the deployed release.
if [[ -x /usr/local/sbin/khohang-autodeploy && -f "$release_dir/infra/autodeploy/install.sh" ]]; then
  bash "$release_dir/infra/autodeploy/install.sh" --refresh || log 'warning: watcher refresh failed'
fi
