import { expect, test, type Page } from '@playwright/test';
import { mockLayoutAdmin } from './layout-fixtures';

async function fixtures(page: Page) {
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      json: { data: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } },
    }),
  );
  await mockLayoutAdmin(page);
}
async function sidebar(page: Page, href: string) {
  const menu = page.getByRole('button', { name: 'Mở menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.locator(`.sidebar a[href="${href}"]`).click();
}

test('sidebar click from deep list reveals lazy route; POP restores list offset and forward restores destination', async ({
  page,
}) => {
  await fixtures(page);
  await page.goto('/catalog');
  await expect(page.locator('[aria-labelledby="catalog-table-title"] table tbody tr')).toHaveCount(
    24,
  );
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const offset = await page.evaluate(() => window.scrollY);
  expect(offset).toBeGreaterThan(500);
  await sidebar(page, '/warehouse-inbound');
  const heading = page.getByRole('heading', { name: 'Nhập kho tổng', exact: true });
  await expect(heading).toBeInViewport();
  await expect(heading).toBeFocused();
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar--open/);
  await page.goBack();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(offset, -1);
  await page.goForward();
  await expect(heading).toBeInViewport();
});

test('in-page link selects the requested Reshare tab and keyboard retains tab focus', async ({
  page,
}) => {
  await fixtures(page);
  await page.goto('/warehouse-inbound');
  await page.getByRole('link', { name: 'Cập nhật tồn Reshare', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Cập nhật tồn Reshare' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel')).toBeInViewport();
  const tab = page.getByRole('tab', { name: 'Cập nhật tồn Reshare' });
  await tab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { selected: true })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toBeInViewport();
});

test('catalog modal returns focus, filter typing stays put, reduced motion route reveal', async ({
  page,
}) => {
  await fixtures(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/catalog');
  const search = page.getByPlaceholder(/Tìm/).first();
  if (await search.count()) {
    await search.fill('Áo');
    await expect(search).toBeFocused();
  }
  const create = page.getByRole('button', { name: /Thêm mặt hàng/ });
  await create.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(create).toBeFocused();
});

test('delayed deep-link failure focuses the selected detail and subsequent route reaches its heading', async ({
  page,
}) => {
  await fixtures(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/v1/allocation-decisions/00000000-0000-4000-8000-000000009999?includeReshare=true',
    async (route) => {
      await gate;
      await route
        .fulfill({
          status: 404,
          json: {
            error: {
              code: 'NOT_FOUND',
              message: 'Không tìm thấy phiếu',
              requestId: 'navigation-test',
            },
          },
        })
        .catch(() => undefined);
    },
  );
  await page.goto('/allocations?decision=00000000-0000-4000-8000-000000009999');
  await expect(page.getByText('Đang tải phiếu kết quả…')).toBeVisible();
  const detail = page.getByRole('region', { name: 'Phiếu kết quả đang mở' });
  await expect(detail).not.toBeFocused();
  // Initial layout/native anchoring may emit scroll before delayed content arrives.
  // That event belongs to this visit, not a previously saved Back/Forward entry.
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  release();
  await expect(detail.getByRole('alert')).toBeVisible();
  await expect(detail).toBeInViewport();
  await expect(detail).toBeFocused();
  await sidebar(page, '/catalog');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
});

test('hash link reaches and focuses its heading', async ({ page }) => {
  await fixtures(page);
  await page.goto('/catalog#catalog-table-title');
  await expect(page.locator('#catalog-table-title')).toBeInViewport();
  await expect(page.locator('#catalog-table-title')).toBeFocused();
});

test('leaving a pending detail cancels its late focus intent', async ({ page }) => {
  await fixtures(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/v1/allocation-decisions/00000000-0000-4000-8000-000000009998?includeReshare=true',
    async (route) => {
      await gate;
      await route
        .fulfill({
          status: 404,
          json: {
            error: {
              code: 'NOT_FOUND',
              message: 'Không tìm thấy phiếu',
              requestId: 'late-navigation',
            },
          },
        })
        .catch(() => undefined);
    },
  );
  await page.goto('/allocations?decision=00000000-0000-4000-8000-000000009998');
  await expect(page.getByText('Đang tải phiếu kết quả…')).toBeVisible();
  await sidebar(page, '/catalog');
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeFocused();
  release();
  await expect(page.locator('[aria-labelledby="catalog-table-title"] table tbody tr')).toHaveCount(
    24,
  );
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await expect(page.getByRole('region', { name: 'Phiếu kết quả đang mở' })).toHaveCount(0);
});
