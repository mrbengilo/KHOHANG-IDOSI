import { expect, test, type Page } from '@playwright/test';
import { mockLayoutAdmin } from './layout-fixtures';

/** Fails every request for the lazy chunk of one page until `release()` is called. */
async function blockChunk(page: Page, chunkName: string) {
  let blocked = true;
  await page.route(
    (url) => url.pathname.startsWith('/assets/') && url.pathname.includes(chunkName),
    (route) => (blocked ? route.abort('connectionreset') : route.continue()),
  );
  return () => {
    blocked = false;
  };
}

test.describe('route error recovery', () => {
  test.beforeEach(async ({ page }) => {
    await mockLayoutAdmin(page);
    await page.addInitScript(() => localStorage.setItem('idosi-demo-role:v2', 'ADMIN'));
  });

  test('a page chunk that fails to load keeps the shell and offers a reload', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto('/');
    await expect(page.locator('.page-header')).toBeVisible();
    const release = await blockChunk(page, 'CatalogPage');

    await page.goto('/catalog');

    const alert = page.getByRole('alert').filter({ hasText: 'Không tải được màn hình' });
    await expect(alert).toBeVisible();
    await expect(page.getByText('Unexpected Application Error')).toHaveCount(0);
    // The navigation stays usable so the user can leave the broken screen without a reload.
    await expect(page.locator('.sidebar')).toBeAttached();
    await expect(page.getByRole('link', { name: 'Về tổng quan' })).toBeVisible();
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(pageErrors).toEqual([]);

    release();
    await page.getByRole('button', { name: 'Tải lại trang' }).click();
    await expect(page.locator('.page-header h1')).toBeVisible();
    await expect(alert).toHaveCount(0);
  });

  test('leaving a failed screen through the menu renders the next page normally', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'sidebar links are desktop-only');
    await page.goto('/');
    await expect(page.locator('.page-header')).toBeVisible();
    await blockChunk(page, 'CatalogPage');
    await page.goto('/catalog');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Không tải được màn hình' }),
    ).toBeVisible();

    await page.locator('.sidebar').getByRole('link', { name: 'Báo cáo' }).click();

    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.locator('.page-header h1')).toBeVisible();
    await expect(page.getByText('Không tải được màn hình')).toHaveCount(0);
  });
});
