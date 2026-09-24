// Rejects migrations that would break the previous release while it still runs.
//
// deploy.sh migrates while the old containers keep serving, and an automatic rollback restores
// the old images on top of the migrated database (--confirm-forward-compatible-db). Both are only
// safe when every migration is "expand only": the old code must keep working against it. Removing
// or renaming things, changing types or adding required columns belongs in a later "contract"
// release, once no running code depends on the old shape. Such a migration must say so with a
// `-- migration-safety: contract <reason>` line, which makes the decision explicit in review.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Migrations up to this number predate the check and are not re-judged. */
export const FIRST_CHECKED_MIGRATION = 27;

const RULES = [
  { pattern: /\bDROP\s+TABLE\b/iu, reason: 'drops a table' },
  { pattern: /\bDROP\s+COLUMN\b/iu, reason: 'drops a column' },
  { pattern: /\bRENAME\s+(?:COLUMN\b|TO\b|CONSTRAINT\b)/iu, reason: 'renames a table or column' },
  { pattern: /\bALTER\s+COLUMN\s+"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE\b/iu, reason: 'changes a type' },
  {
    pattern: /\bALTER\s+COLUMN\s+"?\w+"?\s+SET\s+NOT\s+NULL\b/iu,
    reason: 'makes a column required',
  },
  { pattern: /\bDROP\s+TYPE\b/iu, reason: 'drops a type' },
];

function addsRequiredColumnWithoutDefault(statement) {
  const match = /\bADD\s+COLUMN\b([\s\S]*)/iu.exec(statement);
  if (!match) return false;
  const definition = match[1];
  return /\bNOT\s+NULL\b/iu.test(definition) && !/\bDEFAULT\b/iu.test(definition);
}

export function migrationViolations(sql) {
  if (/^\s*--\s*migration-safety:\s*contract\s+\S/imu.test(sql)) return [];
  const statements = sql
    .split(/--> statement-breakpoint|;\s*$/mu)
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n'),
    )
    .filter((statement) => statement.trim());
  const violations = [];
  for (const statement of statements) {
    for (const rule of RULES) {
      if (rule.pattern.test(statement)) violations.push(rule.reason);
    }
    if (addsRequiredColumnWithoutDefault(statement)) {
      violations.push('adds a NOT NULL column without a DEFAULT');
    }
  }
  return [...new Set(violations)];
}

export function checkMigrationDirectory(directory) {
  const failures = [];
  for (const file of readdirSync(directory).sort()) {
    const match = /^(\d{4})_[\w-]+\.sql$/u.exec(file);
    if (!match || Number(match[1]) < FIRST_CHECKED_MIGRATION) continue;
    const violations = migrationViolations(readFileSync(join(directory, file), 'utf8'));
    if (violations.length > 0) failures.push({ file, violations });
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const directory = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../packages/database/migrations',
  );
  const failures = checkMigrationDirectory(directory);
  for (const { file, violations } of failures) {
    console.error(`${file}: ${violations.join('; ')}`);
  }
  if (failures.length > 0) {
    console.error(
      'These migrations would break the release that is still running during deploy and after an ' +
        'automatic rollback. Split them into expand and contract releases, or mark a deliberate ' +
        'contract step with "-- migration-safety: contract <reason>".',
    );
    process.exit(1);
  }
  console.log('migration safety: all checked migrations are expand-only');
}
