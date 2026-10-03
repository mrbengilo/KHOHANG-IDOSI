#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Maintenance wrapper for one reviewed reset operation (a later operation uses a new state
# directory and operation ID). Never invoked by deploy, seed, migrate, or a timer.
# Locks cover the entire selected phase. Timers and app writers remain stopped between phases.
# Retention mode (context.backupRetention="retain"): pre-backup -> pre-restore before plan, and
# retain-backups instead of drop-restores/purge-backups/record-backups. No backup is deleted.
command="${1:-help}"
shift || true
state_dir=""
release_sha=""
confirmation=""
while (($#)); do
  case "$1" in
    --state-dir) state_dir="${2:?}"; shift 2 ;;
    --release) release_sha="${2:?}"; shift 2 ;;
    --confirm) confirmation="${2:?}"; shift 2 ;;
    *) printf 'Unknown option\n' >&2; exit 1 ;;
  esac
done
fail() { printf 'reset-test-data: %s\n' "$*" >&2; exit 1; }
[[ "$command" =~ ^(enter|pre-backup|pre-restore|plan|apply|verify|status|backup|restore|inventory-restores|drop-restores|purge-backups|record-backups|retain-backups|leave)$ ]] || fail 'unknown maintenance phase'
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || fail 'full reviewed merged release SHA required'
[[ "$state_dir" == /var/lib/khohang-reset/* && "$state_dir" != *..* ]] || fail 'state directory must be under /var/lib/khohang-reset/'
[[ "$(id -u)" == 0 ]] || fail 'root maintenance session required'
mkdir -p -- "$state_dir"
[[ "$(readlink -f -- "$state_dir")" == "$state_dir" ]] || fail 'state directory cannot be a symlink'
release_dir="$(readlink -f /opt/khohang-idosi/current)"
[[ "$release_dir" == "/opt/khohang-idosi/releases/$release_sha" ]] || fail 'running release differs from reviewed release'
[[ "$(git -C "$release_dir" rev-parse HEAD)" == "$release_sha" ]] || fail 'release checkout mismatch'
[[ -z "$(git -C "$release_dir" status --porcelain --untracked-files=no)" ]] || fail 'release source was modified'
if [[ -f /etc/khohang-idosi/backup.env ]]; then
  # Trusted root-owned application configuration. This release supports the inventoried local
  # target only; any newly configured remote needs an adapter and a new reviewed inventory.
  . /etc/khohang-idosi/backup.env
  [[ -z "${BACKUP_OFFSITE_RCLONE_REMOTE:-}${BACKUP_OFFSITE_RSYNC_TARGET:-}" ]] || fail 'offsite target configured; local-only reset wrapper cannot purge it'
  [[ "${BACKUP_DIR:-/var/backups/khohang-idosi}" == /var/backups/khohang-idosi ]] || fail 'backup root changed'
fi
export IMAGE_TAG="$release_sha"
compose=(docker compose --env-file /etc/khohang-idosi/production.env --file "$release_dir/docker-compose.yml" --project-name khohang-idosi)

if [[ "$command" == enter && ! -f "$state_dir/entered" ]]; then
  [[ ! -e "$state_dir/service-state" ]] || fail 'incomplete maintenance entry: inspect existing state before continuing'
  for service in khohang-autodeploy.timer khohang-backup.timer; do
    printf '%s %s\n' "$service" "$(systemctl is-active "$service" || true)" >>"$state_dir/service-state"
  done
  systemctl stop khohang-autodeploy.timer khohang-backup.timer
  # Do not kill a dump/upload. Drain the entire job, including offsite and prune.
  deadline=$((SECONDS+600))
  while systemctl is-active --quiet khohang-autodeploy.service || systemctl is-active --quiet khohang-backup.service; do
    ((SECONDS<deadline)) || fail 'scheduled job did not drain; timers remain stopped'
    sleep 2
  done
fi
for service in khohang-autodeploy.timer khohang-backup.timer khohang-autodeploy.service khohang-backup.service; do
  ! systemctl is-active --quiet "$service" || fail "maintenance requires $service stopped"
done
exec 8>/var/lib/khohang-autodeploy/autodeploy.lock
flock -w 30 8 || fail 'watcher lock unavailable'
exec 9>/run/lock/khohang-idosi-deploy.lock
flock -w 30 9 || fail 'deploy/backup lock unavailable'

if [[ "$command" == enter ]]; then
  if [[ ! -f "$state_dir/entered" ]]; then
    for service in api worker; do
      "${compose[@]}" exec -T "$service" node -e 'const u=new URL(process.env.DATABASE_URL); if(u.hostname!=="db"||u.pathname!=="/idosi") process.exit(1); console.log(JSON.stringify({host:u.hostname,database:u.pathname,storage:process.env.API_STORAGE||process.env.WORKER_STORAGE}));' >>"$state_dir/runtime-identity.jsonl"
    done
    "${compose[@]}" stop --timeout 120 caddy api worker
    printf '%s\n' "$release_sha" >"$state_dir/entered"
  fi
  printf 'Writers drained; create/review context and inventory before plan/apply.\n'
  exit 0
fi
[[ -f "$state_dir/entered" && "$(cat "$state_dir/entered")" == "$release_sha" ]] || fail 'maintenance has not been entered for this release'
for service in api worker caddy; do
  [[ -z "$("${compose[@]}" ps --status running --services "$service")" ]] || fail "$service is still running"
done
cli() {
  "${compose[@]}" run --rm --no-deps --pull never --user 0:0 --env "RESET_HOST=$(hostname)" --env RESET_PROJECT=khohang-idosi --env "RESET_RELEASE=$release_sha" --volume "$state_dir:/reset" --volume /var/backups/khohang-idosi:/var/backups/khohang-idosi:ro --entrypoint node migrate infra/scripts/reset-test-data.mjs "$@"
}
file_cli() {
  "${compose[@]}" run --rm --no-deps --pull never --user 0:0 --volume "$state_dir:/reset" --volume /var/backups/khohang-idosi:/var/backups/khohang-idosi --entrypoint node migrate infra/scripts/purge-test-data-backups.mjs "$@"
}
pre_proof_args=()
[[ ! -f "$state_dir/pre-proof.json" ]] || pre_proof_args=(--pre-proof /reset/pre-proof.json)
context_operation() {
  "${compose[@]}" run --rm --no-deps --pull never --user 0:0 --volume "$state_dir:/reset:ro" --entrypoint node migrate -e 'console.log(require("/reset/context.json").operationId)'
}
case "$command" in
  pre-backup)
    # Fresh recovery copy of the live data, taken with writers already stopped.
    [[ ! -e "$state_dir/pre.path" ]] || fail 'pre-reset backup already recorded; continue with pre-restore'
    bash "$release_dir/infra/scripts/backup-db.sh" --compose-file "$release_dir/docker-compose.yml" --env-file /etc/khohang-idosi/production.env --output-dir /var/backups/khohang-idosi >"$state_dir/pre-backup.log"
    pre_path="$(sed -n 's/^Verified backup: //p' "$state_dir/pre-backup.log")"
    [[ "$pre_path" =~ ^/var/backups/khohang-idosi/idosi-[0-9TZ]+\.dump$ ]] || fail 'unexpected pre-reset backup path; inspect protected log'
    printf '%s\n' "$pre_path" >"$state_dir/pre.path"
    ;;
  pre-restore)
    operation="$(context_operation)"
    [[ "$operation" =~ ^[a-f0-9-]{36}$ ]] || fail 'invalid operation ID'
    restore_db="idosi_reset_verify_${operation//-/_}_pre"
    pre_path="$(cat "$state_dir/pre.path")"
    [[ "$pre_path" =~ ^/var/backups/khohang-idosi/idosi-[0-9TZ]+\.dump$ ]] || fail 'unexpected pre-reset backup path'
    if [[ ! -e "$state_dir/pre-restore.started" ]]; then
      printf '%s\n' "$restore_db" >"$state_dir/pre-restore.started"
      bash "$release_dir/infra/scripts/restore-db.sh" --compose-file "$release_dir/docker-compose.yml" --env-file /etc/khohang-idosi/production.env --backup "$pre_path" --target-db "$restore_db" --confirm-db "$restore_db"
    fi
    # Compares the restored copy with the live database, then drops only this rehearsal copy.
    cli --command verify-pre-backup --context /reset/context.json --restore-database "$restore_db" --clean-root /var/backups/khohang-idosi --clean-file "$pre_path" --output /reset/pre-proof.json
    ;;
  plan) cli --command plan --context /reset/context.json --inventory /reset/backups.json --restore-inventory /reset/restores.json "${pre_proof_args[@]}" --output /reset/manifest.json ;;
  apply) [[ "$confirmation" =~ ^[a-f0-9]{64}$ ]] || fail 'explicit --confirm manifest hash required'; cli --command apply --manifest /reset/manifest.json --inventory /reset/backups.json --restore-inventory /reset/restores.json "${pre_proof_args[@]}" --confirm "$confirmation" ;;
  verify) cli --command verify --manifest /reset/manifest.json ;;
  backup)
    cli --command verify --manifest /reset/manifest.json
    [[ ! -e "$state_dir/clean.path" ]] || fail 'clean backup already recorded; continue restore/verify'
    bash "$release_dir/infra/scripts/backup-db.sh" --compose-file "$release_dir/docker-compose.yml" --env-file /etc/khohang-idosi/production.env --output-dir /var/backups/khohang-idosi >"$state_dir/clean-backup.log"
    clean_path="$(sed -n 's/^Verified backup: //p' "$state_dir/clean-backup.log")"
    [[ "$clean_path" =~ ^/var/backups/khohang-idosi/idosi-[0-9TZ]+\.dump$ ]] || fail 'unexpected clean backup path; inspect protected log'
    printf '%s\n' "$clean_path" >"$state_dir/clean.path"
    ;;
  restore)
    operation="$(context_operation)"
    [[ "$operation" =~ ^[a-f0-9-]{36}$ ]] || fail 'invalid operation ID'
    restore_db="idosi_reset_verify_${operation//-/_}"
    clean_path="$(cat "$state_dir/clean.path")"
    [[ "$clean_path" =~ ^/var/backups/khohang-idosi/idosi-[0-9TZ]+\.dump$ ]] || fail 'unexpected clean backup path'
    if [[ ! -e "$state_dir/restore.started" ]]; then
      printf '%s\n' "$restore_db" >"$state_dir/restore.started"
      bash "$release_dir/infra/scripts/restore-db.sh" --compose-file "$release_dir/docker-compose.yml" --env-file /etc/khohang-idosi/production.env --backup "$clean_path" --target-db "$restore_db" --confirm-db "$restore_db"
    fi
    # A lost response after restore is resolved by verification. An interrupted partial restore
    # remains blocked for inspection; it is never silently restored over an existing database.
    cli --command verify --restore --restore-database "$restore_db" --manifest /reset/manifest.json --clean-root /var/backups/khohang-idosi --clean-file "$clean_path" --output /reset/clean-proof.json
    ;;
  inventory-restores) cli --command inventory-restores --output /reset/restores-final.json ;;
  drop-restores)
    [[ "$confirmation" =~ ^[a-f0-9]{64}$ ]] || fail 'restore inventory confirmation hash required'
    cli --command drop-restores --restore-inventory /reset/restores-final.json --proof /reset/clean-proof.json --confirm "$confirmation"
    ;;
  purge-backups)
    [[ "$confirmation" =~ ^[a-f0-9]{64}$ ]] || fail 'backup inventory confirmation hash required'
    file_cli --command purge --manifest /reset/backups.json --proof /reset/clean-proof.json --confirm "$confirmation" --journal /reset/backup-purge.jsonl
    ;;
  record-backups) cli --command backups-verified --manifest /reset/manifest.json --inventory /reset/backups.json --restore-inventory /reset/restores-final.json --proof /reset/clean-proof.json --output /reset/complete.json ;;
  retain-backups)
    [[ -f "$state_dir/pre-proof.json" ]] || fail 'retention mode requires the verified pre-reset backup proof'
    cli --command backups-retained --manifest /reset/manifest.json --inventory /reset/backups.json --restore-inventory /reset/restores-final.json --proof /reset/clean-proof.json --pre-proof /reset/pre-proof.json --output /reset/complete.json
    ;;
  status) cli --command status --operation-id "$("${compose[@]}" run --rm --no-deps --pull never --user 0:0 --volume "$state_dir:/reset:ro" --entrypoint node migrate -e 'console.log(require("/reset/context.json").operationId)')" ;;
  leave)
    [[ -f "$state_dir/complete.json" ]] || fail 'clean restore, backup purge/retention and final verification evidence required before leaving maintenance'
    cli --command can-resume-writers --manifest /reset/manifest.json --proof /reset/complete.json
    "${compose[@]}" up --detach --no-deps --pull never --wait --wait-timeout 120 api worker
    "${compose[@]}" up --detach --no-deps --pull never --wait --wait-timeout 120 caddy
    while read -r service state; do
      [[ "$state" != active ]] || systemctl start "$service"
    done <"$state_dir/service-state"
    printf 'Writers and previously active timers restored.\n'
    ;;
esac
