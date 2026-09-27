import { expect, test } from '@playwright/test';
import { mockLayoutAdmin } from './layout-fixtures';

const routesByRole = {
  ADMIN: [
    '/',
    '/warehouse-inbound',
    '/inventory',
    '/allocations',
    '/costs',
    '/transfers',
    '/reports',
  ],
  HTKD: ['/', '/requests', '/receive', '/costs', '/transfers'],
  STORE_RETAIL: ['/', '/requests', '/receive', '/inventory', '/transfers'],
  STORE_WHOLESALE: ['/', '/requests', '/allocations'],
};

for (const [role, routes] of Object.entries(routesByRole)) {
  test(`shared workspace stays within viewport for ${role}`, async ({ page }, testInfo) => {
    await mockLayoutAdmin(page);
    await page.addInitScript((role) => localStorage.setItem('idosi-demo-role:v2', role), role);
    const widths =
      testInfo.project.name === 'desktop-1440'
        ? [821, 1024, 1366, 1440, 1920, 2560]
        : [360, 390, 412, 768, 819, 820];
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator('.page-header')).toBeVisible();
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          `${role} ${route} at ${width}`,
        ).toBeLessThanOrEqual(width);
        const clipped = await page.locator('.panel, .page-header').evaluateAll((elements) =>
          elements
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.x < -1 || r.right > innerWidth + 1);
            })
            .map((el) => el.className),
        );
        expect(clipped, `${role} ${route} at ${width}`).toEqual([]);
      }
    }
  });
}
