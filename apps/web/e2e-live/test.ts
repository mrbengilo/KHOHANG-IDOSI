import { test as base, type Page } from '@playwright/test';
export * from '@playwright/test';

// Unit/integration fixtures deliberately leave blocked source SKUs in the shared test database.
// These workflows acknowledge that separate alert so their own controls remain reachable.
// Alert appearance, dismissal, renewed revisions and product navigation have dedicated browser tests.
export async function livePage(created: Page | Promise<Page>): Promise<Page> {
  const page = await created;
  await page.addLocatorHandler(
    // This runs before every action/assertion. Avoid an ARIA walk of large route DOMs.
    page.locator('.supplier-source-alert[role="alertdialog"]'),
    async (dialog) => {
      await dialog.getByRole('button', { name: 'Tắt thông báo', exact: true }).click();
    },
  );
  return page;
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await use(await livePage(page));
  },
});
