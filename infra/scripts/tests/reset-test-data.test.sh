#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
task_dir="$(mktemp -d)"
backup_pid=""
cleanup() {
  [[ -z "$backup_pid" ]] || kill "$backup_pid" 2>/dev/null || true
  [[ -n "$task_dir" && "$task_dir" != / && -d "$task_dir" ]] && rm -rf -- "$task_dir"
}
trap cleanup EXIT
mkdir -p "$task_dir/bin" "$task_dir/root/release/infra/scripts" "$task_dir/backups"
ln -s "$task_dir/root/release" "$task_dir/root/current"
cat >"$task_dir/root/release/infra/scripts/backup-db.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'fixture dump' >"$BACKUP_DIR/idosi-fixture.dump"
printf 'fixture checksum' >"$BACKUP_DIR/idosi-fixture.dump.sha256"
SH
cat >"$task_dir/root/release/infra/scripts/prune-backups.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if flock -n "$BACKUP_DEPLOY_LOCK" true; then echo 'prune escaped maintenance lock' >&2; exit 1; fi
SH
cat >"$task_dir/bin/rclone" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
touch "$TASK_UPLOAD_STARTED"
while [[ ! -f "$TASK_UPLOAD_RELEASE" ]]; do sleep 0.02; done
SH
chmod 700 "$task_dir/bin/rclone"
export PATH="$task_dir/bin:$PATH" BACKUP_ROOT="$task_dir/root" BACKUP_DIR="$task_dir/backups"
export BACKUP_STATE_DIR="$task_dir/state" BACKUP_DEPLOY_LOCK="$task_dir/deploy.lock"
export KHOHANG_BACKUP_CONFIG="$task_dir/no-config" BACKUP_OFFSITE_RCLONE_REMOTE=fixture:backups
export TASK_UPLOAD_STARTED="$task_dir/upload-started" TASK_UPLOAD_RELEASE="$task_dir/upload-release"
bash "$repo/infra/backup/khohang-backup.sh" >"$task_dir/backup.log" &
backup_pid=$!
for ((i=0;i<200;i++)); do
  [[ -f "$TASK_UPLOAD_STARTED" ]] && break
  sleep 0.02
done
[[ -f "$TASK_UPLOAD_STARTED" ]] || { cat "$task_dir/backup.log"; exit 1; }
if flock -n "$BACKUP_DEPLOY_LOCK" true; then echo 'upload escaped maintenance lock' >&2; exit 1; fi
touch "$TASK_UPLOAD_RELEASE"
wait "$backup_pid"
backup_pid=""
flock -n "$BACKUP_DEPLOY_LOCK" true
grep -q 'state=succeeded' "$BACKUP_STATE_DIR/status"

# Argument validation must precede service or filesystem mutation.
for unsafe in / '' /var/lib/khohang-reset/../outside; do
  if bash "$repo/infra/scripts/reset-test-data.sh" apply --release 1111111111111111111111111111111111111111 --state-dir "$unsafe" >"$task_dir/refusal.log" 2>&1; then
    echo 'unsafe state root was accepted' >&2; exit 1
  fi
done
printf 'reset maintenance lock and argument safety tests passed\n'
