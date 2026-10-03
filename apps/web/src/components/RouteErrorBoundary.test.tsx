import { renderToStaticMarkup } from 'react-dom/server';
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
  type RouteObject,
} from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../lib/api';
import { isChunkLoadError, RouteErrorBoundary } from './RouteErrorBoundary';

async function renderFailure(error: unknown, layout: 'page' | 'workspace' = 'workspace') {
  const routes: RouteObject[] = [
    {
      path: '/',
      errorElement: <RouteErrorBoundary layout={layout} />,
      loader: () => {
        throw error;
      },
      element: <p>never rendered</p>,
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request('http://localhost/'));
  if (context instanceof Response) throw new Error('unexpected redirect');
  return renderToStaticMarkup(
    <StaticRouterProvider
      context={context}
      hydrate={false}
      router={createStaticRouter(routes, context)}
    />,
  );
}

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/A.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Unable to preload CSS for https://x/assets/A.css',
  ])('recognises %s', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('does not treat render bugs or non-errors as chunk failures', () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of null (reading 'id')"))).toBe(
      false,
    );
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });
});

describe('RouteErrorBoundary', () => {
  it('offers a full reload for a chunk that failed to load', async () => {
    const html = await renderFailure(new TypeError('Failed to fetch dynamically imported module'));
    expect(html).toContain('role="alert"');
    expect(html).toContain('Không tải được màn hình');
    expect(html).toContain('Tải lại trang');
    expect(html).toContain('href="/"');
    expect(html).not.toContain('Hey developer');
  });

  it('offers a re-render for other errors without leaking the message', async () => {
    const html = await renderFailure(new TypeError('secret internal detail'), 'page');
    expect(html).toContain('route-error--page');
    expect(html).toContain('Màn hình gặp lỗi khi hiển thị');
    expect(html).toContain('Thử hiển thị lại');
    expect(html).not.toContain('secret internal detail');
  });

  it('shows the request id of an API failure so it can be traced in the server log', async () => {
    const html = await renderFailure(new ApiClientError('boom', 500, 'INTERNAL_ERROR', 'req-42'));
    expect(html).toContain('Mã yêu cầu: req-42');
  });
});
