#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

# Pull-based continuous deployment. Run periodically by
# khohang-autodeploy.timer: when the tip of the release branch differs from
# the running release and its GitHub CI has passed, check the commit out from
# a local mirror and run that commit's own infra/scripts/deploy.sh. The VPS
# only makes outbound HTTPS requests; GitHub needs no SSH key or secret.

config_file="${AUTODEPLOY_CONFIG:-/etc/khohang-idosi/autodeploy.env}"
if [[ -r "$config_file" ]]; then
  # shellcheck disable=SC1090
  . "$config_file"
fi

repository="${AUTODEPLOY_REPOSITORY:-mrbengilo/KHOHANG-IDOSI}"
branch="${AUTODEPLOY_BRANCH:-main}"
required_check="${AUTODEPLOY_REQUIRED_CHECK:-Node 24 / PostgreSQL 17}"
root_dir="${AUTODEPLOY_ROOT:-/opt/khohang-idosi}"
env_file="${AUTODEPLOY_ENV_FILE:-/etc/khohang-idosi/production.env}"
state_dir="${AUTODEPLOY_STATE_DIR:-/var/lib/khohang-autodeploy}"
pause_file="${AUTODEPLOY_PAUSE_FILE:-/etc/khohang-idosi/autodeploy.paused}"
github_api="${AUTODEPLOY_GITHUB_API:-https://api.github.com}"
remote_url="${AUTODEPLOY_REMOTE_URL:-https://github.com/${repository}.git}"
github_token="${AUTODEPLOY_GITHUB_TOKEN:-}"
# Extra deploy.sh options, split on whitespace (used by tests).
# shellcheck disable=SC2206
deploy_args=(${AUTODEPLOY_DEPLOY_ARGS:-})
mirror_dir="${root_dir}/repo.git"
sha_pattern='^[0-9a-f]{40}$'

mkdir -p -- "$state_dir/failed" "$state_dir/logs"
exec 8>"$state_dir/autodeploy.lock"
flock -n 8 || exit 0

running_sha="$(basename -- "$(readlink -f -- "$root_dir/current" || true)")"
target_sha=""

# Writes the machine-readable status file and logs only state transitions so
# the journal is not flooded by idle checks.
report() {
  local state="$1"
  local detail="$2"
  local summary="state=${state} target=${target_sha:-unknown} running=${running_sha:-unknown} detail=${detail}"
  printf '%s\n' \
    "updated=$(date -Is)" \
    "state=${state}" \
    "target=${target_sha}" \
    "running=${running_sha}" \
    "detail=${detail}" >"$state_dir/status.tmp"
  mv -f -- "$state_dir/status.tmp" "$state_dir/status"
  if [[ "$(cat -- "$state_dir/last-summary" 2>/dev/null || true)" != "$summary" ]]; then
    printf 'autodeploy: %s\n' "$summary"
    printf '%s\n' "$summary" >"$state_dir/last-summary"
  fi
}

if [[ -e "$pause_file" ]]; then
  report paused "remove $pause_file to resume automatic deployment"
  exit 0
fi

if ! target_sha="$(git ls-remote "$remote_url" "refs/heads/${branch}" | awk 'NR == 1 { print $1 }')" ||
  [[ ! "$target_sha" =~ $sha_pattern ]]; then
  target_sha=""
  report error "could not read refs/heads/${branch} from ${remote_url}"
  exit 0
fi

if [[ "$target_sha" == "$running_sha" ]]; then
  report up-to-date "${branch} is live"
  exit 0
fi

if [[ -e "$state_dir/failed/$target_sha" ]]; then
  report skipped "$(cat -- "$state_dir/failed/$target_sha"); waiting for a newer commit"
  exit 0
fi

# A deployment started by hand passes the production env file to Compose.
if pgrep -f -- "--env-file ${env_file}" >/dev/null; then
  report busy 'another deployment command is running'
  exit 0
fi

ci_state() {
  local response
  local -a headers=(-H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28')
  [[ -n "$github_token" ]] && headers+=(-H "Authorization: Bearer ${github_token}")
  response="$(mktemp)"
  if ! curl --fail --silent --show-error --max-time 20 "${headers[@]}" --output "$response" \
    "${github_api}/repos/${repository}/commits/${1}/check-runs?per_page=100"; then
    rm -f -- "$response"
    printf 'unknown\n'
    return 0
  fi
  python3 - "$response" "$required_check" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    runs = json.load(handle).get("check_runs", [])
latest = {}
for run in runs:
    name = run.get("name")
    if name not in latest or run.get("id", 0) > latest[name].get("id", 0):
        latest[name] = run
if any(
    run.get("status") == "completed"
    and run.get("conclusion") not in ("success", "neutral", "skipped")
    for run in latest.values()
):
    print("failure")
elif sys.argv[2] not in latest or any(run.get("status") != "completed" for run in latest.values()):
    print("pending")
else:
    print("success")
PY
  rm -f -- "$response"
}

case "$(ci_state "$target_sha")" in
  success) ;;
  pending)
    report waiting-ci "waiting for '${required_check}' to pass"
    exit 0
    ;;
  failure)
    printf 'CI failed\n' >"$state_dir/failed/$target_sha"
    report ci-failed 'GitHub CI failed; this commit will not be deployed'
    exit 0
    ;;
  *)
    report error 'could not read CI status from GitHub'
    exit 0
    ;;
esac

release_dir="${root_dir}/releases/${target_sha}"
log_file="${state_dir}/logs/${target_sha}.log"
report deploying "log: ${log_file}"

{
  if [[ ! -d "$mirror_dir" ]]; then
    git clone --bare --quiet "$remote_url" "$mirror_dir"
  fi
  git --git-dir="$mirror_dir" fetch --quiet "$remote_url" "+refs/heads/${branch}:refs/heads/${branch}"
  if [[ ! -e "$release_dir" ]]; then
    git --git-dir="$mirror_dir" worktree add --detach "$release_dir" "$target_sha"
  fi
} >>"$log_file" 2>&1 || {
  printf 'could not check out the release\n' >"$state_dir/failed/$target_sha"
  report failed "could not check out the release; see ${log_file}"
  exit 1
}

deploy_script="${release_dir}/infra/scripts/deploy.sh"
if [[ ! -f "$deploy_script" ]]; then
  printf 'release has no infra/scripts/deploy.sh\n' >"$state_dir/failed/$target_sha"
  report failed 'release has no infra/scripts/deploy.sh'
  exit 1
fi

if bash "$deploy_script" --sha "$target_sha" --root "$root_dir" --env-file "$env_file" --yes \
  "${deploy_args[@]}" 2>&1 | tee -a "$log_file"; then
  running_sha="$(basename -- "$(readlink -f -- "$root_dir/current")")"
  report deployed "log: ${log_file}"
else
  running_sha="$(basename -- "$(readlink -f -- "$root_dir/current" || true)")"
  printf 'deployment failed\n' >"$state_dir/failed/$target_sha"
  report failed "deployment failed; the log shows whether services were restored: ${log_file}"
  exit 1
fi
