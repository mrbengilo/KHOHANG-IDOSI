#!/usr/bin/env bash
set -Eeuo pipefail

# Installs (or, with --refresh, updates) the automatic deployment watcher from
# this checkout. Run as root on the VPS from a release checkout.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root_dir="${AUTODEPLOY_ROOT:-/opt/khohang-idosi}"
remote_url="${AUTODEPLOY_REMOTE_URL:-https://github.com/mrbengilo/KHOHANG-IDOSI.git}"
sbin_path=/usr/local/sbin/khohang-autodeploy
backup_sbin_path=/usr/local/sbin/khohang-backup
unit_dir=/etc/systemd/system
mode=install

usage() {
  printf '%s\n' \
    'Usage: install.sh [--refresh]' \
    '' \
    '  (no option)  Install the watcher, create the Git mirror and start the timer' \
    '  --refresh    Only update the installed script and systemd units'
}

fail() {
  printf 'autodeploy-install: %s\n' "$*" >&2
  exit 1
}

case "${1:-}" in
  '') ;;
  --refresh) mode=refresh ;;
  --help | -h)
    usage
    exit 0
    ;;
  *) fail "unknown argument: $1" ;;
esac
(($# <= 1)) || fail 'too many arguments'
((EUID == 0)) || fail 'run as root'

# Replace files by rename so a watcher that is currently running keeps
# reading its original script.
install_atomic() {
  local source="$1"
  local destination="$2"
  local file_mode="$3"
  local temporary
  temporary="$(mktemp "${destination}.XXXXXX")"
  cp -- "$source" "$temporary"
  chmod "$file_mode" -- "$temporary"
  mv -f -- "$temporary" "$destination"
}

install_atomic "$script_dir/khohang-autodeploy.sh" "$sbin_path" 0755
install_atomic "$script_dir/khohang-autodeploy.service" "$unit_dir/khohang-autodeploy.service" 0644
install_atomic "$script_dir/khohang-autodeploy.timer" "$unit_dir/khohang-autodeploy.timer" 0644

# The nightly backup ships with the watcher: every deployment refreshes it, so
# a VPS that only ever receives automatic deployments still gets daily backups.
backup_source="$(cd -- "$script_dir/../backup" && pwd -P)"
install_atomic "$backup_source/khohang-backup.sh" "$backup_sbin_path" 0755
install_atomic "$backup_source/khohang-backup.service" "$unit_dir/khohang-backup.service" 0644
install_atomic "$backup_source/khohang-backup.timer" "$unit_dir/khohang-backup.timer" 0644
systemctl daemon-reload
systemctl enable --now khohang-backup.timer >/dev/null

if [[ "$mode" == refresh ]]; then
  printf 'autodeploy watcher and nightly backup refreshed from %s\n' "$script_dir"
  exit 0
fi

[[ -L "$root_dir/current" ]] || fail "missing symlink: $root_dir/current"
if [[ ! -d "$root_dir/repo.git" ]]; then
  git clone --bare --quiet "$remote_url" "$root_dir/repo.git"
fi

# Seed the release history from the newest existing release directories so
# the first cleanup keeps the images needed for a quick rollback.
history_file="$root_dir/deploy-history"
if [[ ! -s "$history_file" ]]; then
  current_sha="$(basename -- "$(readlink -f -- "$root_dir/current")")"
  while IFS= read -r release; do
    sha="$(basename -- "$release")"
    [[ "$sha" =~ ^[0-9a-f]{40}$ && "$sha" != "$current_sha" ]] || continue
    printf 'seeded %s\n' "$sha" >>"$history_file"
  done < <(ls -1dtr -- "$root_dir"/releases/*/ | tail -n 5)
  printf 'seeded %s\n' "$current_sha" >>"$history_file"
fi

systemctl enable --now khohang-autodeploy.timer
systemctl list-timers khohang-autodeploy.timer --no-pager
printf 'autodeploy installed; status: /var/lib/khohang-autodeploy/status\n'
