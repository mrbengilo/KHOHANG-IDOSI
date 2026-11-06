import { test as base } from '@playwright/test';
export * from '@playwright/test';

// Unit/integration fixtures deliberately leave blocked source SKUs in the shared test database.
// These workflows acknowledge that separate alert so their own controls remain reachable.
// Alert appearance, dismissal, renewed revisions and product navigation have dedicated browser tests.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addLocatorHandler(
      page.getByRole('alertdialog', { name: 'CẦN ĐỐI CHIẾU TỒN RESHARE NGAY' }),
      async (dialog) => {
        await dialog.getByRole('button', { name: 'Tắt thông báo', exact: true }).click();
      },
    );
    await use(page);
  },
});
