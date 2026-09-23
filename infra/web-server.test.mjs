import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('a new web release keeps previous lazy-loaded assets available', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'idosi-web-assets-'));
  const root = join(workspace, 'public');
  const firstAssets = join(workspace, 'first-assets');
  const secondAssets = join(workspace, 'second-assets');
  const port = await availablePort();

  try {
    await Promise.all([
      mkdir(join(root, 'assets'), { recursive: true }),
      mkdir(firstAssets),
      mkdir(secondAssets),
    ]);
    await writeFile(join(root, 'index.html'), 'first release');
    await writeFile(join(firstAssets, 'DashboardPage-oldhash.js'), 'export const release = 1;');

    await withWebServer({ root, source: firstAssets, port }, async () => {
      const oldAsset = await fetch(`http://127.0.0.1:${port}/assets/DashboardPage-oldhash.js`);
      assert.equal(oldAsset.status, 200);
      assert.equal(await oldAsset.text(), 'export const release = 1;');
    });

    await writeFile(join(root, 'index.html'), 'second release');
    await writeFile(join(secondAssets, 'DashboardPage-newhash.js'), 'export const release = 2;');

    await withWebServer({ root, source: secondAssets, port }, async () => {
      const base = `http://127.0.0.1:${port}`;
      const [entry, oldAsset, newAsset, missingAsset] = await Promise.all([
        fetch(base),
        fetch(`${base}/assets/DashboardPage-oldhash.js`),
        fetch(`${base}/assets/DashboardPage-newhash.js`),
        fetch(`${base}/assets/DashboardPage-missing.js`),
      ]);

      assert.equal(await entry.text(), 'second release');
      assert.equal(entry.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
      assert.equal(await oldAsset.text(), 'export const release = 1;');
      assert.equal(oldAsset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(await newAsset.text(), 'export const release = 2;');
      assert.equal(missingAsset.status, 404);
    });

    assert.equal(
      await readFile(join(root, 'assets', 'DashboardPage-oldhash.js'), 'utf8'),
      'export const release = 1;',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function withWebServer({ root, source, port }, run) {
  const child = spawn(process.execPath, ['infra/web-server.mjs'], {
    env: {
      ...process.env,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      WEB_ROOT: root,
      WEB_ASSET_SOURCE: source,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(
        () => reject(new Error(`Web server did not start: ${output}`)),
        5000,
      );
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.includes('web_server_started')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Web server exited with ${code}: ${output}`));
      });
    });

    await run();
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}
