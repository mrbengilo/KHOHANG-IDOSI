import { expect, test } from '@playwright/test';
import { routesByRole } from './desktop-route-matrix';
import { mockLayoutAdmin } from './layout-fixtures';

// Every route each mock principal may open, at the representative viewports plus both sides of
// the CSS breakpoints the shell and tables switch on (390, 420, 520, 600, 620, 700, 760, 768,
// 820, 900, 1050, 1100, 1366).
const mobileWidths = [
  360, 390, 391, 412, 421, 521, 601, 620, 621, 640, 700, 761, 768, 769, 819, 820,
];
const desktopWidths = [821, 901, 1024, 1051, 1101, 1365, 1366, 1440, 1920, 2560];

for (const [role, routes] of Object.entries(routesByRole)) {
  test(`shared workspace stays within viewport for ${role}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await mockLayoutAdmin(page);
    await page.addInitScript((role) => localStorage.setItem('idosi-demo-role:v2', role), role);
    const widths = testInfo.project.name === 'desktop-1440' ? desktopWidths : mobileWidths;
    for (const route of routes) {
      await page.goto(route);
      // The mock build shows a placeholder (no page header) for screens that need the real API.
      await expect(
        page.locator('.app-main > *:not(.priority-offer-notices)').first(),
      ).toBeVisible();
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        const label = `${role} ${route} at ${width}`;
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          label,
        ).toBeLessThanOrEqual(width);
        const clipped = await page.locator('.panel, .page-header').evaluateAll((elements) =>
          elements
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.x < -1 || r.right > innerWidth + 1);
            })
            .map((el) => el.className),
        );
        expect(clipped, label).toEqual([]);
        // `.button` clips its overflow, so a squeezed button hides part of its own label.
        const squeezed = await page
          .locator('.app-main .button')
          .evaluateAll((buttons) =>
            buttons
              .filter((b) => b.clientWidth > 0 && b.scrollWidth > b.clientWidth + 1)
              .map((b) => `${b.textContent?.trim()} ${b.scrollWidth}/${b.clientWidth}`),
          );
        expect(squeezed, label).toEqual([]);
      }
    }
  });
}
