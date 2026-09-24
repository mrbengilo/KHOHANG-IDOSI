import { createServer, type Server } from 'node:http';

import type { AllocationWorker } from './worker.js';

export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startHealthServer(
  worker: AllocationWorker,
  options: HealthServerOptions,
): Promise<HealthServer> {
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('allow', 'GET');
      response.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }
    if (request.url === '/health') {
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true, state: worker.state() }));
      return;
    }
    if (request.url === '/ready') {
      let database = false;
      try {
        await worker.ping();
        database = true;
      } catch {
        database = false;
      }
      const ready = database && worker.isReady();
      response.statusCode = ready ? 200 : 503;
      // Failed allocation jobs are reported, not turned into a 503: Docker and deployments must
      // keep the loop running so it can retry and so a fix can be deployed.
      response.end(
        JSON.stringify({
          ok: ready,
          database,
          degraded: worker.isDegraded(),
          state: worker.state(),
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  await listen(server, options);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close(server);
    throw new Error('Health server did not bind a TCP port.');
  }
  return { port: address.port, close: () => close(server) };
}

function listen(server: Server, options: HealthServerOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(options.port, options.host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
