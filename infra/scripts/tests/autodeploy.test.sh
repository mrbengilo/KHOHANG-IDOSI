#!/usr/bin/env bash
set -Eeuo pipefail

# Exercises deploy.sh and the auto-deploy watcher against fake docker/curl
# binaries and throwaway Git repositories. Nothing touches a real daemon.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_dir="$(cd -- "${script_dir}/../../.." && pwd -P)"
temporary_dir="$(mktemp -d)"
fake_bin="${temporary_dir}/bin"
docker_log="${temporary_dir}/docker.log"
curl_log="${temporary_dir}/curl.log"
root_dir="${temporary_dir}/opt"
env_file="${temporary_dir}/production.env"
state_dir="${temporary_dir}/state"
old_sha="1111111111111111111111111111111111111111"

cleanup() {
  rm -rf -- "$temporary_dir"
}
trap cleanup EXIT

fail() {
  printf 'autodeploy.test: %s\n' "$*" >&2
  exit 1
}

git_quiet() {
  git -c user.name=ci -c user.email=ci@example.invalid -c init.defaultBranch=main "$@" >/dev/null 2>&1
}

mkdir -p -- "$fake_bin" "$root_dir/releases/$old_sha/infra/scripts"
cp -- "${script_dir}/bin/docker" "${fake_bin}/docker"
cat >"${fake_bin}/curl" <<'CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$FAKE_CURL_LOG"
output=""
url="${*: -1}"
previous=""
for argument in "$@"; do
  [[ "$previous" == --output ]] && output="$argument"
  previous="$argument"
done
if [[ "$url" == */check-runs* ]]; then
  cp -- "$FAKE_CHECK_RUNS" "$output"
  exit 0
fi
[[ "${FAKE_CURL_FAIL:-0}" == 1 ]] && exit 22
[[ -n "$output" ]] || printf 'ok'
CURL
chmod 700 -- "${fake_bin}/docker" "${fake_bin}/curl"
export PATH="${fake_bin}:$PATH" FAKE_DOCKER_LOG="$docker_log" FAKE_CURL_LOG="$curl_log"

# The previous release only needs the files the rollback path reads.
cp -- "${repository_dir}/docker-compose.yml" "$root_dir/releases/$old_sha/"
cp -- "${repository_dir}/infra/scripts/rollback.sh" "$root_dir/releases/$old_sha/infra/scripts/"

reset_production() {
  ln -sfn -- "$root_dir/releases/$old_sha" "$root_dir/current"
  printf '%s\n' \
    'APP_DOMAIN=khoidosi.io.vn' \
    'IMAGE_PREFIX=local/khohang-idosi' \
    "IMAGE_TAG=${old_sha}" \
    'POSTGRES_PASSWORD=placeholder' >"$env_file"
  chmod 600 -- "$env_file"
  : >"$docker_log"
  : >"$curl_log"
}

# Builds a commit containing the real deployment files and returns its SHA.
source_repo="${temporary_dir}/source"
mkdir -p -- "$source_repo/infra/scripts"
git_quiet init "$source_repo"
cp -- "${repository_dir}/"{docker-compose.yml,Caddyfile} "$source_repo/"
cp -- "${repository_dir}/infra/scripts/"{deploy.sh,backup-db.sh,prune-backups.sh,rollback.sh,normalize-release-permissions.py} "$source_repo/infra/scripts/"
printf '{"private":true}\n' >"$source_repo/package.json"
printf '.env\n' >"$source_repo/.gitignore"
printf 'tracked build input\n' >"$source_repo/infra/scripts/file with spaces.txt"
ln -s -- "$env_file" "$source_repo/config-link"
new_commit() {
  printf '%s\n' "$1" >"$source_repo/marker"
  git_quiet -C "$source_repo" add -A
  git_quiet -C "$source_repo" commit -m "$1"
  git -C "$source_repo" rev-parse HEAD
}

run_deploy() {
  local sha="$1"
  shift
  bash "$root_dir/releases/$sha/infra/scripts/deploy.sh" \
    --sha "$sha" --root "$root_dir" --env-file "$env_file" \
    --backup-dir "${temporary_dir}/backups-${sha}-${RANDOM}" --lock-file "${temporary_dir}/deploy.lock" \
    --min-free-gb 0 --yes "$@"
}

image_tag() {
  sed -n 's/^IMAGE_TAG=//p' "$env_file"
}

# 1. A successful deployment builds, migrates, replaces services, verifies
# HTTPS and only then records the new release and removes stale images.
sha_a="$(new_commit a)"
(
  umask 077
  git_quiet clone "$source_repo" "$root_dir/releases/$sha_a"
  printf 'private placeholder\n' >"$root_dir/releases/$sha_a/.env"
)
[[ "$(stat -c %a -- "$root_dir/releases/$sha_a/package.json")" == 600 ]] || fail 'test checkout is not restrictive'
reset_production
FAKE_IMAGE_LIST="local/khohang-idosi-api:2222222222222222222222222222222222222222 local/khohang-idosi-api:${old_sha}" \
  run_deploy "$sha_a" >/dev/null
[[ "$(readlink -f -- "$root_dir/current")" == "$root_dir/releases/$sha_a" ]] || fail 'current was not switched'
[[ "$(image_tag)" == "$sha_a" ]] || fail 'IMAGE_TAG was not updated after a verified deployment'
[[ "$(stat -c %a -- "$env_file")" == 600 ]] || fail 'environment file permissions changed'
[[ "$(stat -c %a -- "$root_dir/releases/$sha_a/package.json")" == 644 ]] || fail 'existing restrictive checkout was not repaired'
[[ "$(stat -c %a -- "$root_dir/releases/$sha_a/.env")" == 600 ]] || fail 'ignored environment file permissions changed'
[[ "$(stat -c %a -- "$root_dir/releases/$sha_a/.git/config")" == 600 ]] || fail 'Git metadata permissions changed'
[[ "$(stat -c %a -- "$root_dir/releases/$sha_a/infra/scripts/file with spaces.txt")" == 644 ]] || fail 'tracked filename containing spaces was not repaired'
python3 "$root_dir/releases/$sha_a/infra/scripts/normalize-release-permissions.py"
[[ -z "$(git -C "$root_dir/releases/$sha_a" status --porcelain)" ]] || fail 'permission repair changed tracked content or executable modes'
tail -n 1 "$root_dir/deploy-history" | grep -q " ${sha_a}$" || fail 'deployment history was not recorded'
grep -Eq "TAG=${sha_a}[|]ARGS=compose .* build --pull api migrate worker web" "$docker_log" || \
  fail 'application images were not built for the release SHA'
grep -Eq "TAG=${sha_a}[|]ARGS=compose .* run --rm --no-deps --pull never migrate" "$docker_log" || \
  fail 'migrations were not run with the release images'
grep -Eq "TAG=${sha_a}[|]ARGS=compose .* up .*--pull never .*api worker web caddy" "$docker_log" || \
  fail 'services were not replaced with pinned release images'
grep -q 'https://khoidosi.io.vn/ready' "$curl_log" || fail 'readiness was not verified'
grep -q 'ARGS=image rm local/khohang-idosi-api:2222222222222222222222222222222222222222' "$docker_log" || \
  fail 'stale application image was not removed'
if grep -q "ARGS=image rm local/khohang-idosi-api:${old_sha}" "$docker_log"; then
  fail 'the previous release image was removed'
fi
compgen -G "${temporary_dir}/backups-${sha_a}-*/*.dump" >/dev/null || fail 'no backup was taken before deployment'

# 2. A failed HTTPS check after replacement restores the previous images and
# leaves the environment file and current symlink on the verified release.
sha_b="$(new_commit b)"
git_quiet clone "$source_repo" "$root_dir/releases/$sha_b"
reset_production
if FAKE_CURL_FAIL=1 run_deploy "$sha_b" >"${temporary_dir}/out" 2>&1; then
  fail 'deployment reported success after a failed health check'
fi
[[ "$(readlink -f -- "$root_dir/current")" == "$root_dir/releases/$old_sha" ]] || \
  fail 'current moved to a release that failed verification'
[[ "$(image_tag)" == "$old_sha" ]] || fail 'IMAGE_TAG changed after a failed deployment'
grep -Eq "TAG=${old_sha}[|]ARGS=compose .* up .*api worker web" "$docker_log" || \
  { cat "${temporary_dir}/out"; cut -c1-200 "$docker_log"; fail 'previous release images were not restored'; }

# 3. A build failure never touches running services.
reset_production
if FAKE_FAIL_COMMAND=build run_deploy "$sha_b" >/dev/null 2>&1; then
  fail 'deployment reported success after a failed build'
fi
if grep -Eq 'ARGS=compose .* up .*api' "$docker_log"; then
  fail 'services were replaced after a failed build'
fi
[[ "$(image_tag)" == "$old_sha" ]] || fail 'IMAGE_TAG changed after a failed build'

# 4. The script refuses a checkout whose HEAD is not the requested SHA.
reset_production
if bash "$root_dir/releases/$sha_b/infra/scripts/deploy.sh" --sha "$sha_a" --root "$root_dir" \
  --env-file "$env_file" --lock-file "${temporary_dir}/deploy.lock" --yes >/dev/null 2>&1; then
  fail 'deployment accepted a checkout that does not match --sha'
fi

# 5. The watcher deploys the tip of main only after CI passes and never
# retries a commit whose CI failed.
origin_repo="${temporary_dir}/origin.git"
git_quiet clone --bare "$source_repo" "$origin_repo"
checks="${temporary_dir}/check-runs.json"
export FAKE_CHECK_RUNS="$checks"
run_watcher() {
  AUTODEPLOY_CONFIG=/nonexistent \
    AUTODEPLOY_ROOT="$root_dir" \
    AUTODEPLOY_ENV_FILE="$env_file" \
    AUTODEPLOY_STATE_DIR="$state_dir" \
    AUTODEPLOY_PAUSE_FILE="${temporary_dir}/paused" \
    AUTODEPLOY_REMOTE_URL="$origin_repo" \
    AUTODEPLOY_DEPLOY_ARGS="--backup-dir ${temporary_dir}/backups-watcher --lock-file ${temporary_dir}/deploy.lock --min-free-gb 0" \
    bash "${repository_dir}/infra/autodeploy/khohang-autodeploy.sh" >/dev/null 2>&1
}
watcher_state() {
  sed -n 's/^state=//p' "$state_dir/status"
}
set_checks() {
  printf '{"check_runs":[{"id":%s,"name":"Node 24 / PostgreSQL 17","status":"%s","conclusion":%s}]}\n' \
    "$1" "$2" "$3" >"$checks"
}
push_commit() {
  local sha
  sha="$(new_commit "$1")"
  git_quiet -C "$source_repo" push --force "$origin_repo" HEAD:main
  printf '%s\n' "$sha"
}

reset_production
sha_c="$(push_commit c)"
set_checks 1 in_progress null
run_watcher
[[ "$(watcher_state)" == waiting-ci ]] || fail "watcher did not wait for CI (state: $(watcher_state))"
[[ ! -e "$root_dir/releases/$sha_c" ]] || fail 'watcher checked out a release before CI passed'

set_checks 2 completed '"failure"'
run_watcher
[[ "$(watcher_state)" == ci-failed && -e "$state_dir/failed/$sha_c" ]] || fail 'failed CI was not recorded'
set_checks 3 completed '"success"'
run_watcher
[[ "$(watcher_state)" == skipped ]] || fail 'watcher retried a commit whose CI failed'

touch -- "${temporary_dir}/paused"
sha_d="$(push_commit d)"
run_watcher
[[ "$(watcher_state)" == paused ]] || fail 'watcher ignored the pause file'
rm -f -- "${temporary_dir}/paused"

run_watcher || { cat "$state_dir/status" "$state_dir"/logs/*.log >&2; fail 'watcher failed to deploy a commit with passing CI'; }
[[ "$(watcher_state)" == deployed ]] || fail "watcher did not deploy (state: $(watcher_state))"
[[ "$(stat -c %a -- "$root_dir/releases/$sha_d/package.json")" == 644 ]] || \
  fail 'release package.json is not readable by the non-root migration user'
[[ "$(stat -c %a -- "$root_dir/releases/$sha_d/Caddyfile")" == 644 ]] || \
  fail 'Caddy configuration is not readable by its non-root container user'
[[ "$(stat -c %a -- "$root_dir/releases/$sha_d/infra/scripts")" == 755 ]] || \
  fail 'release source directories are not traversable by container users'
[[ "$(stat -c %a -- "$root_dir/releases/$sha_d/infra/scripts/backup-db.sh")" == 755 ]] || \
  fail 'tracked scripts lost their executable mode'
[[ "$(stat -c %a -- "$env_file")" == 600 ]] || fail 'environment permissions changed through a tracked symlink'
[[ "$(stat -c %a -- "$state_dir/status")" == 600 ]] || fail 'watcher status is no longer private'
[[ "$(stat -c %a -- "$state_dir/logs/$sha_d.log")" == 600 ]] || fail 'deployment log is no longer private'
while IFS= read -r -d '' backup; do
  [[ "$(stat -c %a -- "$backup")" == 600 ]] || fail 'backup permissions are no longer private'
done < <(find "${temporary_dir}/backups-watcher" -type f -print0)
[[ "$(readlink -f -- "$root_dir/current")" == "$root_dir/releases/$sha_d" ]] || \
  fail 'watcher did not switch current to the tip of main'
[[ "$(image_tag)" == "$sha_d" ]] || fail 'watcher deployment did not update IMAGE_TAG'
run_watcher
[[ "$(watcher_state)" == up-to-date ]] || fail 'watcher did not report an up-to-date release'

printf 'autodeploy tests passed\n'
