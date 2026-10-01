import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function checkedRoot(root) {
  if (
    !root ||
    !path.isAbsolute(root) ||
    root.split(/[\\/]/).includes('..') ||
    path.parse(root).root === path.resolve(root)
  )
    throw new Error('Unsafe backup root');
  const resolved = await realpath(root);
  if (resolved !== path.resolve(root) || !(await lstat(root)).isDirectory())
    throw new Error('Backup root must be a real directory, not a symlink');
  return resolved;
}
async function checkedFile(root, file) {
  if (
    !path.isAbsolute(file) ||
    file.split(/[\\/]/).includes('..') ||
    !file.startsWith(root + path.sep)
  )
    throw new Error('Backup path escapes reviewed root');
  const stat = await lstat(file, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    (await realpath(file)) !== file
  )
    throw new Error('Backup must be a regular file without links');
  const rootStat = await lstat(root, { bigint: true });
  if (stat.dev !== rootStat.dev) throw new Error('Unexpected backup mount');
  return {
    path: file,
    size: stat.size.toString(),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    sha256: await checksum(file),
  };
}
export async function inventoryBackupRoot(root) {
  root = await checkedRoot(root);
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symlink found in backup inventory');
      if (entry.isDirectory()) await walk(file);
      else files.push(await checkedFile(root, file));
    }
  }
  await walk(root);
  return { root, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
/** No glob, shell expansion, directory removal, remote-wide deletion, or retention bypass. */
export async function purgeBackupInventory(inventory, cleanFiles, report) {
  const root = await checkedRoot(inventory.root);
  if (inventory.files.some((f) => !['KEEP', 'PURGE'].includes(f.action)))
    throw new Error('Every backup file requires reviewed KEEP/PURGE classification');
  const identity = (file) => {
    const { action: _action, ...value } = file;
    return value;
  };
  const current = await inventoryBackupRoot(root);
  const permitted = new Set([
    ...inventory.files.map((f) => f.path),
    ...cleanFiles.map((f) => f.path),
  ]);
  if (current.files.some((f) => !permitted.has(f.path)))
    throw new Error('Unmanifested backup appeared; stop and refresh inventory');
  for (const file of cleanFiles) {
    if (JSON.stringify(await checkedFile(root, file.path)) !== JSON.stringify(identity(file)))
      throw new Error('Verified clean backup changed');
  }
  if (!cleanFiles.length) throw new Error('Verified clean backup required before purge');
  const kept = new Set([
    ...cleanFiles.map((f) => f.path),
    ...inventory.files.filter((f) => f.action === 'KEEP').map((f) => f.path),
  ]);
  for (const file of inventory.files) {
    if (file.action === 'KEEP') continue;
    if (kept.has(file.path)) throw new Error('Clean file also scheduled for deletion');
    const actual = current.files.find((f) => f.path === file.path);
    if (!actual) {
      await report({ path: file.path, state: 'ABSENT' });
      continue;
    }
    if (JSON.stringify(await checkedFile(root, file.path)) !== JSON.stringify(identity(file)))
      throw new Error('Backup identity changed; refusing deletion');
    await unlink(file.path);
    await report({ path: file.path, state: 'PURGED' });
  }
  const after = await inventoryBackupRoot(root);
  if (after.files.some((f) => !kept.has(f.path))) throw new Error('Backup purge incomplete');
  return { before: inventory.files.length, after: after.files.length, state: 'VERIFIED' };
}
