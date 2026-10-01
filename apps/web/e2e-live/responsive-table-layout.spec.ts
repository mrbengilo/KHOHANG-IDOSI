import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canAccessRoute, routeAccessPolicies } from '../src/lib/access';
import type { Role, StoreKind } from '../src/lib/types';
import {
  measureTableLayout,
  tableLayoutViewports,
  tableLayoutViolations,
  type PageTableLayout,
} from '../e2e/table-layout-metrics';

const api = 'http://127.0.0.1:3100/api/v1';
const admin = {
  username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
  password: process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
};

interface Identity {
  readonly name: string;
  readonly role: Role;
  readonly storeKind: StoreKind | null;
  readonly credentials: typeof admin;
}

interface StoreRow {
  readonly id: string;
  readonly kind: StoreKind;
}

async function signIn(page: Page, credentials: typeof admin) {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(credentials.username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.locator('.app-main')).toBeVisible();
}

/** Accounts for every role and store kind, scoped to stores that already hold test data. */
async function createIdentities(request: APIRequestContext): Promise<Identity[]> {
  expect((await request.post(`${api}/auth/login`, { data: admin })).status()).toBe(200);
  const stores: StoreRow[] = (
    await (await request.get(`${api}/stores?status=ACTIVE&pageSize=100`)).json()
  ).data;
  // Pick the stores that already hold the most store-level documents from earlier workflows.
  const usage = new Map<string, number>();
  for (const resource of [
    'store-inventory-bags',
    'store-bag-openings',
    'store-sorting-history',
    'store-transfers',
    'store-receipts',
    'store-partner-inbounds',
    'order-requests',
  ]) {
    const response = await request.get(`${api}/${resource}?pageSize=100`);
    if (!response.ok()) continue;
    for (const row of ((await response.json()).data ?? []) as Record<string, unknown>[])
      for (const [key, value] of Object.entries(row))
        if (/storeId$/i.test(key) && typeof value === 'string')
          usage.set(value, (usage.get(value) ?? 0) + 1);
  }
  const byUsage = (kind: StoreKind) =>
    stores
      .filter((store) => store.kind === kind)
      .sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0))
      .map((store) => store.id);
  const token = randomUUID().slice(0, 8);
  const identities: Identity[] = [
    { name: 'ADMIN', role: 'ADMIN', storeKind: null, credentials: admin },
  ];
  const variants = [
    { name: 'HTKD', role: 'HTKD', storeKind: null, storeIds: [undefined] },
    { name: 'STORE_RETAIL', role: 'STORE', storeKind: 'RETAIL', storeIds: byUsage('RETAIL') },
    {
      name: 'STORE_WHOLESALE_KIND',
      role: 'STORE',
      storeKind: 'WHOLESALE',
      storeIds: byUsage('WHOLESALE'),
    },
    { name: 'WHOLESALE', role: 'WHOLESALE', storeKind: null, storeIds: [undefined] },
  ] as const;
  for (const variant of variants) {
    const credentials = {
      username: `table.${variant.name.toLowerCase()}.${token}`,
      password: `Test-only-${randomUUID()}!`,
    };
    // Reruns on the same fixture database reuse this spec's own account (password reset), so
    // before/after measurements see the same store and documents.
    const existing = (
      await (
        await request.get(
          `${api}/admin/accounts?role=${variant.role}&status=ACTIVE&search=table.${variant.name.toLowerCase()}.&pageSize=1`,
        )
      ).json()
    ).data[0] as { id: string; username: string; sessionVersion: number } | undefined;
    if (existing) {
      const reset = await request.post(`${api}/admin/accounts/${existing.id}/reset-password`, {
        data: {
          newPassword: credentials.password,
          expectedSessionVersion: existing.sessionVersion,
          revokeSessions: true,
        },
      });
      expect(reset.status(), await reset.text()).toBe(200);
      identities.push({
        name: variant.name,
        role: variant.role,
        storeKind: variant.storeKind,
        credentials: { ...credentials, username: existing.username },
      });
      continue;
    }
    // A store keeps one active store account; take the busiest store that is still free.
    let response;
    for (const storeId of variant.storeIds) {
      response = await request.post(`${api}/admin/accounts`, {
        data: {
          ...credentials,
          displayName: `Table layout ${variant.name}`,
          role: variant.role,
          ...(storeId ? { storeId } : {}),
        },
      });
      if (response.status() !== 409) break;
    }
    expect(response!.status(), await response!.text()).toBe(201);
    if (variant.role === 'HTKD') {
      const accountId = (await response!.json()).data.id;
      const assigned = await request.put(`${api}/admin/accounts/${accountId}/assignments`, {
        data: {
          expectedSessionVersion: 0,
          storeIds: stores.map((store) => store.id),
          reason: 'Phạm vi kiểm thử bố cục bảng',
        },
      });
      expect(assigned.status()).toBe(200);
    }
    identities.push({
      name: variant.name,
      role: variant.role,
      storeKind: variant.storeKind,
      credentials,
    });
  }
  return identities;
}

/** Waits until lazy queries stop changing the rendered tables. */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  const snapshot = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.app-main table, .app-main [aria-busy="true"]'))
        .map((node) => node.textContent)
        .join('|'),
    );
  let previous = await snapshot();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(250);
    const current = await snapshot();
    if (current === previous && !(await page.locator('.app-main [aria-busy="true"]').count()))
      return;
    previous = current;
  }
}

/** Initial render plus every workspace tab; closed <details> holding tables are opened. */
async function* routeStates(page: Page): AsyncGenerator<string> {
  const openDetails = async () => {
    await settle(page);
    await page.evaluate(() => {
      for (const details of Array.from(document.querySelectorAll('.app-main details')))
        if (details.querySelector('table')) (details as HTMLDetailsElement).open = true;
    });
  };
  await openDetails();
  yield 'initial';
  // Receipt lines render only for a selected receipt or receipt source.
  for (const card of ['.receipt-card', '.receipt-source-card']) {
    const first = page.locator(`.app-main ${card}`).first();
    if (!(await first.isVisible())) continue;
    await page.setViewportSize({ width: 1440, height: 900 });
    await first.click();
    await page.waitForLoadState('networkidle');
    await openDetails();
    yield `selected:${card.slice(1)}`;
  }
  const tabs = page.locator('.app-main [role="tab"]');
  const names = await tabs.allTextContents();
  for (const [index, name] of names.entries()) {
    await page.setViewportSize({ width: 1440, height: 900 });
    const tab = tabs.nth(index);
    if (!(await tab.isVisible()) || (await tab.getAttribute('aria-selected')) === 'true') continue;
    await tab.click();
    await page.waitForLoadState('networkidle');
    await openDetails();
    yield `tab:${name.trim()}`;
  }
}

test('tables are centred, content-sized, left aligned and scroll locally for every role', async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(1_500_000);
  const identities = await createIdentities(request);
  const records: {
    identity: string;
    route: string;
    state: string;
    height: number;
    layout: PageTableLayout;
  }[] = [];
  for (const identity of identities) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await signIn(page, identity.credentials);
    for (const route of Object.keys(routeAccessPolicies)) {
      if (!canAccessRoute(route, identity.role, identity.storeKind)) continue;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(route);
      await expect(page.locator('.page-header')).toBeVisible();
      await page.waitForLoadState('networkidle');
      for await (const state of routeStates(page)) {
        let reference: string[] | undefined;
        for (const [width, height] of tableLayoutViewports) {
          await page.setViewportSize({ width, height });
          const layout = await measureTableLayout(page);
          const where = `${identity.name} ${route} ${state} ${width}x${height}`;
          expect.soft(tableLayoutViolations(layout), where).toEqual([]);
          // Layout must never change the records: same table text at every viewport. A table
          // without rows has nothing to show as cards (its header is visually hidden there).
          const texts = layout.tables.filter((table) => table.rows).map((table) => table.text);
          if (reference === undefined) reference = texts;
          else expect.soft(texts, `${where} table content`).toEqual(reference);
          const shots = process.env.TABLE_LAYOUT_SCREENSHOT_DIR;
          if (shots && [1920, 390].includes(width) && layout.tables.some((table) => table.rows)) {
            const slug = `${identity.name}${route}-${state}-${width}`.replace(/[^\w-]+/g, '_');
            await page.screenshot({
              path: path.join(shots, `${slug}.png`),
              animations: 'disabled',
            });
          }
          records.push({
            identity: identity.name,
            route,
            state,
            height,
            layout: {
              ...layout,
              tables: layout.tables.map((table) => ({ ...table, text: table.text.slice(0, 160) })),
            },
          });
        }
      }
    }
    expect.soft(errors, `${identity.name} page errors`).toEqual([]);
    await context.close();
  }
  const body = JSON.stringify(records, null, 2);
  await testInfo.attach('table-layout-measurements', {
    body,
    contentType: 'application/json',
  });
  const evidence = process.env.TABLE_LAYOUT_EVIDENCE_FILE;
  if (evidence) {
    mkdirSync(path.dirname(evidence), { recursive: true });
    writeFileSync(evidence, body);
  }
  const withData = records.filter((record) => record.layout.tables.some((table) => table.rows));
  expect(withData.length, 'states that rendered table rows').toBeGreaterThan(0);
});
