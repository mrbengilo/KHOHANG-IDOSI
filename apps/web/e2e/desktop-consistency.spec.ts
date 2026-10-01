import { expect, test, type Page } from '@playwright/test';
import { routesByRole } from './desktop-route-matrix';
import { mockLayoutAdmin } from './layout-fixtures';

/**
 * Desktop design system (docs/desktop-ui-consistency.md): one vertical rhythm between page
 * blocks, one box style, one control size and tables that span their box.
 */
async function useRole(page: Page, role: string) {
  await mockLayoutAdmin(page);
  await page.addInitScript((value) => localStorage.setItem('idosi-demo-role:v2', value), role);
}

const viewports = [
  [1366, 768],
  [1920, 1080],
] as const;

for (const [role, routes] of Object.entries(routesByRole)) {
  test(`desktop blocks, boxes, controls and tables are uniform for ${role}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only matrix');
    await useRole(page, role);
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator('.app-main > *').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      for (const [width, height] of viewports) {
        await page.setViewportSize({ width, height });
        const label = `${role} ${route} @${width}`;
        const m = await page.evaluate(() => {
          const shown = (el: Element) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).position !== 'fixed';
          };
          // Gaps between consecutive blocks of every stack container.
          const stacks = [
            '.app-main',
            '.app-main .admin-feature',
            '.app-main .dashboard-page',
            '.app-main .tab-panel',
          ];
          const gaps: number[] = [];
          for (const selector of stacks)
            for (const stack of document.querySelectorAll(selector)) {
              const blocks = [...stack.children].filter(
                (el) => shown(el) && getComputedStyle(el).position !== 'sticky',
              );
              for (let i = 1; i < blocks.length; i += 1)
                gaps.push(
                  Math.round(
                    blocks[i]!.getBoundingClientRect().top -
                      blocks[i - 1]!.getBoundingClientRect().bottom,
                  ),
                );
            }
          const boxes = [
            ...document.querySelectorAll<HTMLElement>(
              '.app-main :is(.page-header, .panel, .admin-panel, .settings-panel, .inbound-panel)',
            ),
          ].filter(shown);
          const radii = new Set(boxes.map((el) => getComputedStyle(el).borderTopLeftRadius));
          const controls = [
            ...document.querySelectorAll<HTMLElement>(
              '.app-main :is(input:not([type=checkbox]):not([type=radio]):not([type=range]), select):not(table *):not(.bag-picker__stepper *)',
            ),
          ].filter(shown);
          const controlHeights = controls.map((el) =>
            Math.round(el.getBoundingClientRect().height),
          );
          const controlFonts = new Set(controls.map((el) => getComputedStyle(el).fontSize));
          const narrowTables = [
            ...document.querySelectorAll<HTMLElement>(
              '.app-main :is(.responsive-table, .document-history, .admin-table-wrap, .inbound-table-scroll) > table',
            ),
          ]
            .filter(shown)
            .filter(
              (table) => table.getBoundingClientRect().width < table.parentElement!.clientWidth - 1,
            )
            .map((table) => table.parentElement!.className);
          return {
            gaps,
            radii: [...radii],
            controlHeights,
            controlFonts: [...controlFonts],
            narrowTables,
          };
        });
        for (const gap of m.gaps) expect(gap, `${label} block gap`).toBe(16);
        expect(m.radii, `${label} box radius`).toEqual(m.radii.length ? ['12px'] : []);
        for (const h of m.controlHeights) {
          expect(h, `${label} control height`).toBeGreaterThanOrEqual(36);
          expect(h, `${label} control height`).toBeLessThanOrEqual(40);
        }
        expect(m.controlFonts, `${label} control font`).toEqual(
          m.controlFonts.length ? ['14px'] : [],
        );
        expect(m.narrowTables, `${label} tables narrower than their box`).toEqual([]);
      }
    }
  });
}
