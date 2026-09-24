#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_dir="$(cd -- "${script_dir}/../../.." && pwd -P)"
temporary_dir="$(mktemp -d)"
fake_bin="${temporary_dir}/bin"
docker_log="${temporary_dir}/docker.log"
env_file="${temporary_dir}/production.env"

cleanup() {
  rm -rf -- "$temporary_dir"
}
trap cleanup EXIT

fail() {
  printf 'deployment-scripts.test: %s\n' "$*" >&2
  exit 1
}

assert_compose_received_env_file() {
  local line
  while IFS= read -r line; do
    if [[ "$line" == *'ARGS=compose '* && "$line" != *'--env-file '* ]]; then
      fail "Compose invocation omitted --env-file: $line"
    fi
  done <"$docker_log"
}

mkdir -p -- "$fake_bin"
cp -- "${script_dir}/bin/docker" "${fake_bin}/docker"
chmod 700 -- "${fake_bin}/docker"
printf '%s\n' \
  'APP_DOMAIN=khoidosi.io.vn' \
  'DATABASE_URL=postgresql://idosi:placeholder@db:5432/idosi' \
  'IMAGE_PREFIX=local/khohang-idosi' \
  'IMAGE_TAG=0000000000000000000000000000000000000000' \
  'POSTGRES_PASSWORD=placeholder' \
  'WEB_ORIGIN=https://khoidosi.io.vn' >"$env_file"

# Backup and restore must pass the protected production environment file to
# every Compose invocation instead of relying on a checkout-local .env file.
: >"$docker_log"
PATH="${fake_bin}:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  bash "${repository_dir}/infra/scripts/backup-db.sh" \
    --env-file "$env_file" \
    --output-dir "${temporary_dir}/backups" >/dev/null
assert_compose_received_env_file
compgen -G "${temporary_dir}/backups/*.dump" >/dev/null || fail 'backup archive was not created'

archive="${temporary_dir}/restore.dump"
printf 'fake-custom-format-backup' >"$archive"
(
  cd -- "$temporary_dir"
  sha256sum -- "$(basename -- "$archive")" >"$(basename -- "$archive").sha256"
)
: >"$docker_log"
PATH="${fake_bin}:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  bash "${repository_dir}/infra/scripts/restore-db.sh" \
    --env-file "$env_file" \
    --backup "$archive" \
    --target-db idosi_restore \
    --confirm-db idosi_restore >/dev/null
assert_compose_received_env_file

from_tag="1111111111111111111111111111111111111111"
to_tag="2222222222222222222222222222222222222222"

# Local rollback is offline, verifies both immutable tag sets first, and pins
# the replacement step to the already validated images.
: >"$docker_log"
PATH="${fake_bin}:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  bash "${repository_dir}/infra/scripts/rollback.sh" \
    --env-file "$env_file" \
    --image-source local \
    --from-tag "$from_tag" \
    --to-tag "$to_tag" \
    --confirm-forward-compatible-db \
    --yes >/dev/null
assert_compose_received_env_file
if grep -Eq 'ARGS=compose .* pull ' "$docker_log"; then
  fail 'local rollback unexpectedly contacted a registry'
fi
grep -Eq 'ARGS=compose .* up .*--pull never' "$docker_log" || \
  fail 'rollback replacement did not disable implicit pulls'
[[ "$(grep -c 'ARGS=image inspect ' "$docker_log")" -eq 6 ]] || \
  fail 'rollback did not verify all current and target images'

# Registry rollback pulls both the target and the automatic recovery tag before
# replacing any service.
: >"$docker_log"
PATH="${fake_bin}:$PATH" FAKE_DOCKER_LOG="$docker_log" FAKE_IMAGE_PREFIX='registry.example/idosi/khohang' \
  bash "${repository_dir}/infra/scripts/rollback.sh" \
    --env-file "$env_file" \
    --image-source registry \
    --from-tag "$from_tag" \
    --to-tag "$to_tag" \
    --confirm-forward-compatible-db \
    --yes >/dev/null
[[ "$(grep -Ec 'ARGS=compose .* pull ' "$docker_log")" -eq 2 ]] || \
  fail 'registry rollback did not pre-pull both tag sets'
assert_compose_received_env_file

# A missing local image must fail before Compose is allowed to replace a
# running service.
: >"$docker_log"
if PATH="${fake_bin}:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  FAKE_MISSING_IMAGE_PATTERN="-worker:${to_tag}" \
  bash "${repository_dir}/infra/scripts/rollback.sh" \
    --env-file "$env_file" \
    --image-source local \
    --from-tag "$from_tag" \
    --to-tag "$to_tag" \
    --confirm-forward-compatible-db \
    --yes >/dev/null 2>&1; then
  fail 'rollback accepted a missing local target image'
fi
if grep -Eq 'ARGS=compose .* up ' "$docker_log"; then
  fail 'rollback replaced services after an image preflight failure'
fi

# If the target fails its health gate, the prevalidated original tag is used
# for recovery and the command still reports failure to the operator.
: >"$docker_log"
if PATH="${fake_bin}:$PATH" FAKE_DOCKER_LOG="$docker_log" FAKE_FAIL_TAG="$to_tag" \
  bash "${repository_dir}/infra/scripts/rollback.sh" \
    --env-file "$env_file" \
    --image-source local \
    --from-tag "$from_tag" \
    --to-tag "$to_tag" \
    --confirm-forward-compatible-db \
    --yes >/dev/null 2>&1; then
  fail 'rollback hid a failed target health gate'
fi
grep -Eq "TAG=${to_tag}.*ARGS=compose .* up " "$docker_log" || fail 'target tag was not attempted'
grep -Eq "TAG=${from_tag}.*ARGS=compose .* up " "$docker_log" || fail 'original tag was not restored'

# The source mode and environment file are explicit safety inputs.
if bash "${repository_dir}/infra/scripts/rollback.sh" \
  --image-source invalid \
  --from-tag "$from_tag" \
  --to-tag "$to_tag" \
  --confirm-forward-compatible-db \
  --yes >/dev/null 2>&1; then
  fail 'rollback accepted an invalid image source'
fi
if bash "${repository_dir}/infra/scripts/backup-db.sh" \
  --env-file "${temporary_dir}/missing.env" \
  --output-dir "${temporary_dir}/backups" >/dev/null 2>&1; then
  fail 'backup accepted an unreadable environment file'
fi

# Retention keeps the newest dumps, one per recent day and one per recent ISO
# week, removes each pruned dump together with its checksum and never touches
# files that are not backup-db.sh archives.
prune_dir="${temporary_dir}/prune"
mkdir -p -- "$prune_dir"
make_dump() {
  printf 'dump' >"${prune_dir}/idosi-$1.dump"
  printf 'sum' >"${prune_dir}/idosi-$1.dump.sha256"
}
for day in $(seq 0 39); do
  make_dump "$(date -u -d "2026-09-30 - ${day} days" +%Y%m%d)T020000Z"
done
make_dump 20260930T100000Z
make_dump 20260930T150000Z
printf 'keep me' >"${prune_dir}/operator-notes.txt"
printf 'keep me' >"${prune_dir}/idosi-manual.dump"
bash "${repository_dir}/infra/scripts/prune-backups.sh" \
  --backup-dir "$prune_dir" --config "${temporary_dir}/missing-backup.env" \
  --keep-daily 7 --keep-weekly 4 --keep-latest 3 >/dev/null
remaining="$(find "$prune_dir" -name 'idosi-2026*.dump' | wc -l)"
# 3 newest (all 2026-09-30) + 6 older days + the Sunday-ending weeks not
# already covered: 2026-W39..W36 minus the week that the daily set covers.
[[ "$remaining" -ge 10 && "$remaining" -le 12 ]] || fail "unexpected retained dump count: $remaining"
for kept in 20260930T150000Z 20260930T100000Z 20260930T020000Z 20260924T020000Z; do
  [[ -f "${prune_dir}/idosi-${kept}.dump" ]] || fail "retention removed a required dump: $kept"
done
[[ ! -e "${prune_dir}/idosi-20260822T020000Z.dump" ]] || fail 'an expired dump was kept'
[[ ! -e "${prune_dir}/idosi-20260822T020000Z.dump.sha256" ]] || fail 'an expired checksum was kept'
[[ -f "${prune_dir}/operator-notes.txt" && -f "${prune_dir}/idosi-manual.dump" ]] ||
  fail 'retention removed a file it does not own'
while IFS= read -r dump; do
  [[ -f "${dump}.sha256" ]] || fail "retained dump lost its checksum: $dump"
done < <(find "$prune_dir" -name 'idosi-2026*.dump')

# The nightly job backs up through the running release, prunes and records a
# machine-readable status for monitoring.
backup_root="${temporary_dir}/backup-root"
mkdir -p -- "$backup_root/releases/current-release/infra/scripts"
cp -- "${repository_dir}/docker-compose.yml" "$backup_root/releases/current-release/"
cp -- "${repository_dir}/infra/scripts/"{backup-db.sh,prune-backups.sh} \
  "$backup_root/releases/current-release/infra/scripts/"
ln -sfn -- "$backup_root/releases/current-release" "$backup_root/current"
printf '%s\n' \
  "BACKUP_ROOT=${backup_root}" \
  "BACKUP_ENV_FILE=${env_file}" \
  "BACKUP_DIR=${temporary_dir}/nightly" \
  "BACKUP_STATE_DIR=${temporary_dir}/nightly-state" \
  "BACKUP_DEPLOY_LOCK=${temporary_dir}/nightly.lock" \
  'BACKUP_KEEP_DAILY=2' >"${temporary_dir}/backup.env"
: >"$docker_log"
PATH="${fake_bin}:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  KHOHANG_BACKUP_CONFIG="${temporary_dir}/backup.env" \
  bash "${repository_dir}/infra/backup/khohang-backup.sh" >/dev/null
assert_compose_received_env_file
grep -q '^state=succeeded$' "${temporary_dir}/nightly-state/status" || fail 'nightly backup status was not recorded'
grep -q '^offsite=none$' "${temporary_dir}/nightly-state/status" || fail 'missing off-site target was not reported'
compgen -G "${temporary_dir}/nightly/idosi-*.dump" >/dev/null || fail 'nightly backup archive was not created'

rm -f -- "$backup_root/current"
if PATH="${fake_bin}:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  KHOHANG_BACKUP_CONFIG="${temporary_dir}/backup.env" \
  bash "${repository_dir}/infra/backup/khohang-backup.sh" >/dev/null 2>&1; then
  fail 'nightly backup succeeded without a running release'
fi
grep -q '^state=failed$' "${temporary_dir}/nightly-state/status" || fail 'nightly backup failure was not recorded'

printf 'deployment script tests passed\n'
