#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

# Grandfather-father retention for the verified dumps written by backup-db.sh.
# Keeps the newest dump of each of the last N backup days, the newest dump of
# each of the last W ISO weeks and always the newest K dumps overall (several
# deployments on one day each leave a rollback point). Only files that match
# the exact backup-db.sh name are ever considered, so nothing else in the
# directory can be deleted.

backup_dir=""
config_file="/etc/khohang-idosi/backup.env"
keep_daily=""
keep_weekly=""
keep_latest=""
dry_run=false

usage() {
  printf '%s\n' \
    'Usage: prune-backups.sh --backup-dir ABSOLUTE_PATH [options]' \
    '' \
    'Options:' \
    '  --config PATH       Optional retention settings (default: /etc/khohang-idosi/backup.env)' \
    '  --keep-daily N      Backup days to keep (default: BACKUP_KEEP_DAILY or 14)' \
    '  --keep-weekly N     ISO weeks to keep (default: BACKUP_KEEP_WEEKLY or 8)' \
    '  --keep-latest N     Newest dumps always kept (default: BACKUP_KEEP_LATEST or 3)' \
    '  --dry-run           Print what would be removed without removing it' \
    '  --help              Show this help'
}

fail() {
  printf 'prune-backups: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --backup-dir | --config | --keep-daily | --keep-weekly | --keep-latest)
      (($# >= 2)) || fail "$1 requires a value"
      case "$1" in
        --backup-dir) backup_dir="$2" ;;
        --config) config_file="$2" ;;
        --keep-daily) keep_daily="$2" ;;
        --keep-weekly) keep_weekly="$2" ;;
        --keep-latest) keep_latest="$2" ;;
      esac
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

# Settings file values only fill in what the command line did not set.
config_value() {
  [[ -r "$config_file" ]] || return 0
  sed -n "s/^$1=//p" "$config_file" | tail -n 1 | tr -d "\"' "
}
keep_daily="${keep_daily:-$(config_value BACKUP_KEEP_DAILY)}"
keep_weekly="${keep_weekly:-$(config_value BACKUP_KEEP_WEEKLY)}"
keep_latest="${keep_latest:-$(config_value BACKUP_KEEP_LATEST)}"
keep_daily="${keep_daily:-14}"
keep_weekly="${keep_weekly:-8}"
keep_latest="${keep_latest:-3}"

[[ -n "$backup_dir" ]] || fail '--backup-dir is required'
[[ "$backup_dir" = /* ]] || fail '--backup-dir must be an absolute path'
[[ -d "$backup_dir" ]] || fail "backup directory does not exist: $backup_dir"
for value in "$keep_daily" "$keep_weekly" "$keep_latest"; do
  [[ "$value" =~ ^[0-9]+$ ]] || fail "retention values must be non-negative integers: $value"
done
((keep_latest >= 1)) || fail '--keep-latest must be at least 1'

name_pattern='^idosi-([0-9]{8})T[0-9]{6}Z\.dump$'
mapfile -t dumps < <(
  find "$backup_dir" -maxdepth 1 -type f -name 'idosi-*.dump' -printf '%f\n' |
    grep -E "$name_pattern" | sort -r || true
)

declare -A keep=()
declare -A days_seen=()
declare -A weeks_seen=()
index=0
for name in "${dumps[@]}"; do
  [[ "$name" =~ $name_pattern ]]
  day="${BASH_REMATCH[1]}"
  week="$(date -u -d "${day:0:4}-${day:4:2}-${day:6:2}" +%G-%V)"
  if ((index < keep_latest)); then
    keep["$name"]=1
  fi
  if [[ -z "${days_seen[$day]:-}" ]] && ((${#days_seen[@]} < keep_daily)); then
    days_seen["$day"]=1
    keep["$name"]=1
  fi
  if [[ -z "${weeks_seen[$week]:-}" ]] && ((${#weeks_seen[@]} < keep_weekly)); then
    weeks_seen["$week"]=1
    keep["$name"]=1
  fi
  index=$((index + 1))
done

removed=0
for name in "${dumps[@]}"; do
  [[ -n "${keep[$name]:-}" ]] && continue
  if [[ "$dry_run" == true ]]; then
    printf 'would remove %s\n' "$name"
  else
    rm -f -- "${backup_dir}/${name}" "${backup_dir}/${name}.sha256"
  fi
  removed=$((removed + 1))
done

printf 'prune-backups: kept %s, %s %s\n' "${#keep[@]}" \
  "$([[ "$dry_run" == true ]] && printf 'would remove' || printf 'removed')" "$removed"
