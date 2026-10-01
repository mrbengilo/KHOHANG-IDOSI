#!/usr/bin/env node
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { inventoryBackupRoot, purgeBackupInventory } from './test-data-backups.mjs';
const { values } = parseArgs({
  options: {
    command: { type: 'string', default: 'inventory' },
    root: { type: 'string' },
    output: { type: 'string' },
    manifest: { type: 'string' },
    proof: { type: 'string' },
    confirm: { type: 'string' },
    journal: { type: 'string' },
  },
});
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  if (values.command === 'inventory') {
    if (!values.root || !values.output) throw new Error('--root and --output required');
    const inventory = await inventoryBackupRoot(values.root);
    inventory.files = inventory.files.map((file) => ({ ...file, action: 'REVIEW' }));
    await writeFile(values.output, JSON.stringify(inventory, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    console.log(JSON.stringify({ files: inventory.files.length, state: 'REVIEW_REQUIRED' }));
  } else if (values.command === 'hash') {
    if (!values.manifest) throw new Error('--manifest required');
    console.log(hash(JSON.parse(await readFile(values.manifest, 'utf8'))));
  } else if (values.command === 'purge') {
    if (!values.manifest || !values.proof || !values.confirm || !values.journal)
      throw new Error('manifest, clean restore proof, confirmation hash and journal required');
    const inventory = JSON.parse(await readFile(values.manifest, 'utf8'));
    if (hash(inventory) !== values.confirm)
      throw new Error('Backup manifest confirmation mismatch');
    const proof = JSON.parse(await readFile(values.proof, 'utf8'));
    if (
      proof.state !== 'CLEAN_RESTORE_VERIFIED' ||
      !proof.manifestHash ||
      !proof.cleanFiles?.length
    )
      throw new Error('Clean backup restore was not verified');
    console.log(
      JSON.stringify(
        await purgeBackupInventory(inventory, proof.cleanFiles, async (event) => {
          await appendFile(
            values.journal,
            JSON.stringify({ ...event, at: new Date().toISOString() }) + '\n',
            { mode: 0o600 },
          );
        }),
      ),
    );
  } else throw new Error('Unsupported backup command');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Backup maintenance failed');
  process.exitCode = 1;
}
