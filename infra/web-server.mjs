import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const host = process.env.WEB_HOST ?? '0.0.0.0';
const port = parsePort(process.env.WEB_PORT ?? '8080');
const root = resolve(process.env.WEB_ROOT ?? '/app/public');
const assetSource = process.env.WEB_ASSET_SOURCE;

const contentTypes = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');

  if (request.url === '/healthz') {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end('ok\n');
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  try {
    const rawPathname = (request.url ?? '/').split('?', 1)[0] ?? '/';
    const decodedRawPathname = decodeURIComponent(rawPathname);
    if (
      decodedRawPathname.includes('\0') ||
      decodedRawPathname.split('/').some((segment) => segment.startsWith('.'))
    ) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    const relativePath = pathname.replace(/^\/+/, '') || 'index.html';
    let filePath = resolve(root, relativePath);

    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(400);
      response.end();
      return;
    }

    let fileStat = await statFile(filePath);
    if (fileStat?.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      fileStat = await statFile(filePath);
    }

    // Client-side routes have no extension. Missing assets remain a real 404.
    if (!fileStat && extname(pathname) === '') {
      filePath = resolve(root, 'index.html');
      fileStat = await statFile(filePath);
    }

    if (!fileStat?.isFile()) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    const etag = `W/"${fileStat.size.toString(16)}-${Math.trunc(fileStat.mtimeMs).toString(16)}"`;
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { ETag: etag });
      response.end();
      return;
    }

    const extension = extname(filePath).toLowerCase();
    const isEntryDocument = filePath === resolve(root, 'index.html');
    const isHashedAsset = pathname.startsWith('/assets/');

    response.writeHead(200, {
      'Cache-Control': isEntryDocument
        ? 'no-cache, no-store, must-revalidate'
        : isHashedAsset
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
      'Content-Length': fileStat.size,
      'Content-Type': contentTypes.get(extension) ?? 'application/octet-stream',
      ETag: etag,
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    const stream = createReadStream(filePath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch (error) {
    if (error instanceof URIError) {
      response.writeHead(400);
      response.end();
      return;
    }

    console.error('Static file request failed.');
    response.writeHead(500, { 'Cache-Control': 'no-store' });
    response.end();
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

if (assetSource) {
  await publishAssets(resolve(assetSource), resolve(root, 'assets'));
}

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: 'web_server_started', host, port }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error('Static web server shutdown failed.');
        process.exitCode = 1;
      }
    });

    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

async function statFile(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return undefined;
    }
    throw error;
  }
}

async function publishAssets(source, destination) {
  await mkdir(destination, { recursive: true });

  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);

    if (entry.isDirectory()) {
      await publishAssets(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      try {
        // Content-hashed files from earlier releases must stay available to open tabs.
        await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      } catch (error) {
        if (!error || typeof error !== 'object' || error.code !== 'EEXIST') {
          throw error;
        }
      }
    } else {
      throw new Error(`Unsupported asset entry: ${sourcePath}`);
    }
  }
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('WEB_PORT must be an integer between 1 and 65535.');
  }
  return parsed;
}
