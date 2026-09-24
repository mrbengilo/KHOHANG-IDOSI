#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

# Scheduled database backup, run daily by khohang-backup.timer. Deployments
# also back up first, but a quiet week without merges must not leave the
# system without a recent restore point. Each run:
#   1. writes a verified dump with the running release's backup-db.sh,
#   2. applies the retention policy (prune-backups.sh),
#   3. optionally copies the new dump off the VPS,
#   4. records the outcome in a status file an operator (or monitor) can read.
# It waits for, and never overlaps with, a deployment.

config_file="${KHOHANG_BACKUP_CONFIG:-/etc/khohang-idosi/backup.env}"
if [[ -r "$config_file" ]]; then
  # shellcheck disable=SC1090
  . "$config_file"
fi

root_dir="${BACKUP_ROOT:-/opt/khohang-idosi}"
env_file="${BACKUP_ENV_FILE:-/etc/khohang-idosi/production.env}"
backup_dir="${BACKUP_DIR:-/var/backups/khohang-idosi}"
state_dir="${BACKUP_STATE_DIR:-/var/lib/khohang-backup}"
lock_file="${BACKUP_DEPLOY_LOCK:-/run/lock/khohang-idosi-deploy.lock}"
lock_wait_seconds="${BACKUP_LOCK_WAIT_SECONDS:-3600}"
# Optional off-VPS copies; leave both empty to keep backups on the VPS only.
#   BACKUP_OFFSITE_RCLONE_REMOTE=gdrive:khohang-idosi-backups   (needs rclone configured for root)
#   BACKUP_OFFSITE_RSYNC_TARGET=backup@host:/srv/khohang-idosi  (needs an SSH key for root)
offsite_rclone="${BACKUP_OFFSITE_RCLONE_REMOTE:-}"
offsite_rsync="${BACKUP_OFFSITE_RSYNC_TARGET:-}"

mkdir -p -- "$state_dir"

report() {
  printf '%s\n' \
    "state=$1" \
    "updated_at=$(date -Is)" \
    "backup=${2:-}" \
    "offsite=${3:-}" \
    "detail=${4:-}" >"$state_dir/status.tmp"
  mv -f -- "$state_dir/status.tmp" "$state_dir/status"
}

on_error() {
  local status=$?
  report failed "" "" "backup run failed at stage=${stage:-start} (exit ${status})"
  exit "$status"
}
stage=start
trap on_error ERR

release_dir="$(readlink -f -- "$root_dir/current")"
backup_script="$release_dir/infra/scripts/backup-db.sh"
prune_script="$release_dir/infra/scripts/prune-backups.sh"
[[ -f "$backup_script" ]] || {
  report failed "" "" "missing $backup_script"
  exit 1
}

# Deployments hold this lock while they back up, migrate and swap services.
stage=lock
exec 9>"$lock_file"
flock -w "$lock_wait_seconds" 9

stage=backup
before="$(mktemp)"
find "$backup_dir" -maxdepth 1 -type f -name 'idosi-*.dump' -printf '%f\n' 2>/dev/null |
  sort >"$before" || true
bash "$backup_script" \
  --compose-file "$release_dir/docker-compose.yml" \
  --env-file "$env_file" \
  --output-dir "$backup_dir"
latest="$(find "$backup_dir" -maxdepth 1 -type f -name 'idosi-*.dump' -printf '%f\n' |
  sort | comm -13 "$before" - | tail -n 1)"
rm -f -- "$before"
[[ -n "$latest" ]] || {
  report failed "" "" 'backup-db.sh finished but no new dump was found'
  exit 1
}
flock -u 9

stage=prune
if [[ -f "$prune_script" ]]; then
  bash "$prune_script" --backup-dir "$backup_dir" --config "$config_file"
fi

stage=offsite
copies=()
if [[ -n "$offsite_rclone" ]]; then
  rclone copy --no-traverse "$backup_dir/$latest" "$offsite_rclone"
  rclone copy --no-traverse "$backup_dir/$latest.sha256" "$offsite_rclone"
  copies+=("rclone:${offsite_rclone}")
fi
if [[ -n "$offsite_rsync" ]]; then
  rsync --archive --partial -- "$backup_dir/$latest" "$backup_dir/$latest.sha256" "$offsite_rsync/"
  copies+=("rsync:${offsite_rsync}")
fi
offsite="${copies[*]:-none}"

trap - ERR
if [[ "$offsite" == none ]]; then
  report succeeded "$latest" none 'backup kept on this VPS only; configure an off-site target'
else
  report succeeded "$latest" "$offsite" ''
fi
printf 'khohang-backup: %s (offsite: %s)\n' "$latest" "$offsite"
