import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkedRoot, inventoryBackupRoot, purgeBackupInventory } from './test-data-backups.mjs';

test('refuses filesystem roots, traversal and empty paths', async () => {
  for (const root of ['', path.parse(process.cwd()).root, 'relative', '/tmp/../tmp'])
    await assert.rejects(checkedRoot(root));
});
test('purges exact manifested files, keeps clean copies and config, resumes safely', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reset-backup-test-'));
  try {
    await writeFile(path.join(root, 'old dump ; $().dump'), 'old fixture');
    await writeFile(path.join(root, 'config'), 'keep');
    const inventory = await inventoryBackupRoot(root);
    inventory.files = inventory.files.map((f) => ({
      ...f,
      action: f.path.endsWith('config') ? 'KEEP' : 'PURGE',
    }));
    await writeFile(path.join(root, 'clean.dump'), 'clean fixture');
    const clean = (await inventoryBackupRoot(root)).files.filter((f) =>
      f.path.endsWith('clean.dump'),
    );
    const report = [];
    await purgeBackupInventory(inventory, clean, async (item) => report.push(item));
    assert.equal(report[0].state, 'PURGED');
    await purgeBackupInventory(inventory, clean, async (item) => report.push(item));
    assert.equal(report[1].state, 'ABSENT');
    assert.equal(await readFile(path.join(root, 'config'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('refuses changed objects, unmanifested files, unreviewed entries and symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reset-backup-test-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'reset-outside-test-'));
  try {
    await writeFile(path.join(root, 'old.dump'), 'fixture');
    const inventory = await inventoryBackupRoot(root);
    await writeFile(path.join(root, 'clean.dump'), 'clean');
    const clean = (await inventoryBackupRoot(root)).files.filter((f) =>
      f.path.endsWith('clean.dump'),
    );
    await assert.rejects(
      purgeBackupInventory(inventory, clean, async () => {}),
      /classification/,
    );
    inventory.files = inventory.files.map((f) => ({ ...f, action: 'PURGE' }));
    await writeFile(path.join(root, 'old.dump'), 'changed');
    await assert.rejects(
      purgeBackupInventory(inventory, clean, async () => {}),
      /identity/,
    );
    await writeFile(path.join(root, 'new.dump'), 'new');
    await assert.rejects(
      purgeBackupInventory(inventory, clean, async () => {}),
      /Unmanifested/,
    );
    await symlink(
      outside,
      path.join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(inventoryBackupRoot(root), /Symlink/);
    assert.equal(await readFile(path.join(root, 'old.dump'), 'utf8'), 'changed');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
