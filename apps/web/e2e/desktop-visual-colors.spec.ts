import { expect, test, type Page } from '@playwright/test';
import { desktopViewports, routesByRole } from './desktop-route-matrix';
import { mockLayoutAdmin } from './layout-fixtures';

/** WCAG relative luminance of an sRGB `rgb()/rgba()` computed colour. */
function luminance(color: string) {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

async function useRole(page: Page, role: string) {
  await mockLayoutAdmin(page);
  await page.addInitScript((value) => localStorage.setItem('idosi-demo-role:v2', value), role);
}

for (const [role, routes] of Object.entries(routesByRole)) {
  test(`desktop workspace is centred and contained for ${role}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only matrix');
    await useRole(page, role);
    for (const route of routes) {
      await page.goto(route);
      await expect(
        page.locator('.app-main > *:not(.priority-offer-notices)').first(),
      ).toBeVisible();
      for (const [width, height] of desktopViewports) {
        await page.setViewportSize({ width, height });
        const label = `${role} ${route} @${width}`;
        const m = await page.evaluate(() => {
          const main = document.querySelector('.app-main')!.getBoundingClientRect();
          const edges = (selector: string) =>
            [...document.querySelectorAll<HTMLElement>(selector)]
              .filter((el) => !el.closest('.sidebar'))
              .map((el) => el.getBoundingClientRect())
              .filter((r) => r.width > 0);
          // Every top-level block of the workspace must sit on the same centred axis.
          const blocks = [...document.querySelectorAll<HTMLElement>('.app-main > *')]
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0);
          return {
            scrollWidth: document.documentElement.scrollWidth,
            asymmetric: blocks.filter(
              (r) => Math.abs(r.left - main.left - (main.right - r.right)) > 2,
            ).length,
            blocks: blocks.length,
            escaped: edges('.panel, .page-header, table').filter(
              (r) => r.left < -1 || r.right > innerWidth + 1,
            ).length,
          };
        });
        expect(m.scrollWidth, label).toBeLessThanOrEqual(width + 1);
        expect(m.blocks, label).toBeGreaterThan(0);
        expect(m.asymmetric, label).toBe(0);
        expect(m.escaped, label).toBe(0);
      }
    }
  });
}

test('denied route redirects to the overview and unknown path is centred', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only matrix');
  await useRole(page, 'STORE_WHOLESALE');
  await page.goto('/users');
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/khong-ton-tai');
  for (const [width, height] of desktopViewports) {
    await page.setViewportSize({ width, height });
    const box = await page.locator('.not-found > h1').boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThanOrEqual(2);
  }
});

test('semantic tones keep readable contrast and priority is not success green', async ({
  page,
}) => {
  await useRole(page, 'ADMIN');
  await page.goto('/');
  const result = await page.evaluate(() => {
    const tones = ['neutral', 'info', 'success', 'warning', 'danger', 'priority', 'accent'];
    const host = document.createElement('div');
    host.innerHTML = tones
      .map(
        (t) =>
          `<span class="badge badge--${t}" data-t="${t}">x</span>` +
          `<article class="stat-card stat-card--${t}" data-s="${t}"><strong>1</strong></article>` +
          `<article class="stat-card stat-card--${t} stat-card--important" data-i="${t}"><strong>1</strong></article>`,
      )
      .join('');
    document.body.append(host);
    const read = (el: Element) => {
      const cs = getComputedStyle(el);
      return { fg: cs.color, bg: cs.backgroundColor };
    };
    const out = tones.flatMap((t) => [
      { name: `badge ${t}`, ...read(host.querySelector(`[data-t="${t}"]`)!) },
      {
        name: `stat ${t}`,
        fg: getComputedStyle(host.querySelector(`[data-s="${t}"] strong`)!).color,
        bg: getComputedStyle(host.querySelector(`[data-s="${t}"]`)!).backgroundColor,
      },
      {
        name: `stat ${t} important`,
        fg: getComputedStyle(host.querySelector(`[data-i="${t}"] strong`)!).color,
        bg: getComputedStyle(host.querySelector(`[data-i="${t}"]`)!).backgroundColor,
      },
    ]);
    host.remove();
    return out;
  });
  for (const { name, fg, bg } of result) {
    expect(contrast(fg, bg), name).toBeGreaterThanOrEqual(4.5);
  }
  const color = (name: string) => result.find((r) => r.name === name)!.fg;
  expect(color('badge priority')).not.toBe(color('badge success'));
  for (const tone of ['success', 'info', 'warning', 'accent'])
    expect(color(`stat ${tone} important`), tone).toBe(color('stat danger'));
});
