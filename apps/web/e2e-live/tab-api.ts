import type { APIRequestContext, Page } from '@playwright/test';

const TAB_ID_STORAGE_KEY = 'idosi-auth-tab-id:v1';

/** Playwright's request context shares cookies with the page, but not its per-tab header. */
export function tabApi(page: Page) {
  const withTabHeader = async (headers?: Record<string, string>) => {
    const tabId =
      page.url() === 'about:blank'
        ? null
        : await page.evaluate((key) => window.sessionStorage.getItem(key), TAB_ID_STORAGE_KEY);
    return tabId ? { ...headers, 'x-idosi-tab-id': tabId } : headers;
  };
  return {
    get: async (url: string, options?: Parameters<APIRequestContext['get']>[1]) =>
      page.request.get(url, { ...options, headers: await withTabHeader(options?.headers) }),
    post: async (url: string, options?: Parameters<APIRequestContext['post']>[1]) =>
      page.request.post(url, { ...options, headers: await withTabHeader(options?.headers) }),
    put: async (url: string, options?: Parameters<APIRequestContext['put']>[1]) =>
      page.request.put(url, { ...options, headers: await withTabHeader(options?.headers) }),
    patch: async (url: string, options?: Parameters<APIRequestContext['patch']>[1]) =>
      page.request.patch(url, { ...options, headers: await withTabHeader(options?.headers) }),
  };
}
