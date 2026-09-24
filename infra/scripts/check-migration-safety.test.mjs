import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkMigrationDirectory, migrationViolations } from './check-migration-safety.mjs';

test('accepts additive migrations', () => {
  assert.deepEqual(
    migrationViolations(
      'CREATE TABLE "a" ("id" uuid PRIMARY KEY NOT NULL);--> statement-breakpoint\n' +
        'ALTER TABLE "b" ADD COLUMN "c" boolean DEFAULT false NOT NULL;--> statement-breakpoint\n' +
        'ALTER TABLE "b" ADD COLUMN "d" text;\nCREATE INDEX "b_d_idx" ON "b" ("d");',
    ),
    [],
  );
});

test('rejects changes the running release cannot survive', () => {
  assert.deepEqual(migrationViolations('ALTER TABLE "b" DROP COLUMN "c";'), ['drops a column']);
  assert.deepEqual(migrationViolations('ALTER TABLE "b" RENAME COLUMN "c" TO "d";'), [
    'renames a table or column',
  ]);
  assert.deepEqual(migrationViolations('ALTER TABLE "b" ALTER COLUMN "c" SET DATA TYPE bigint;'), [
    'changes a type',
  ]);
  assert.deepEqual(migrationViolations('ALTER TABLE "b" ALTER COLUMN "c" SET NOT NULL;'), [
    'makes a column required',
  ]);
  assert.deepEqual(migrationViolations('ALTER TABLE "b" ADD COLUMN "c" text NOT NULL;'), [
    'adds a NOT NULL column without a DEFAULT',
  ]);
  assert.deepEqual(migrationViolations('DROP TABLE "b";'), ['drops a table']);
});

test('ignores comments and honours an explicit contract marker', () => {
  assert.deepEqual(migrationViolations('-- DROP TABLE "b" happens next release\nSELECT 1;'), []);
  assert.deepEqual(
    migrationViolations('-- migration-safety: contract columns unused since 0027\nDROP TABLE "b";'),
    [],
  );
});

test('checks only migrations from the first checked number on', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migrations-'));
  writeFileSync(join(directory, '0026_old.sql'), 'DROP TABLE "legacy";');
  writeFileSync(join(directory, '0027_new.sql'), 'ALTER TABLE "b" DROP COLUMN "c";');
  assert.deepEqual(checkMigrationDirectory(directory), [
    { file: '0027_new.sql', violations: ['drops a column'] },
  ]);
});
