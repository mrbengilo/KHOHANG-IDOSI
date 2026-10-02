import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { expectedGutter } from './desktop-gutter';
import { layoutAdminSession, mockLayoutAdmin, mockLayoutData } from './layout-fixtures';

/*
 * Production bundle (no mock fallback): login, desktop gutters, navigation typography and the
 * sidebar sign-out button. API responses are deterministic route fixtures; they prove the UI
 * contract, not server authorization (covered by e2e-live and API tests).
 */

/** Saved as a file so CI uploads it with the screenshots (browser-evidence artifact). */
async function saveMeasurements(testInfo: TestInfo, name: string, data: unknown) {
  const path = testInfo.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(data, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

const desktopOnly = (projectName: string) =>
  test.skip(projectName !== 'desktop-1440', 'Desktop layout contract.');

const apiError = (code: string, message: string) => ({
  error: { code, message, requestId: 'e2e-request' },
});

async function signedOut(page: Page) {
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ status: 401, json: apiError('UNAUTHENTICATED', 'Chưa đăng nhập.') }),
  );
}

async function settled(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page
        .locator('img')
        .evaluateAll((images: HTMLImageElement[]) => images.every((image) => image.complete)),
    )
    .toBe(true);
}

/** WCAG contrast of `foreground` against the darkest/lightest composited background pixel. */
async function minContrastBehind(
  page: Page,
  selector: string,
  foreground: [number, number, number],
) {
  const target = page.locator(selector);
  await target.evaluate((element: HTMLElement) =>
    element.style.setProperty('color', 'transparent'),
  );
  const png = await target.screenshot({ animations: 'disabled' });
  await target.evaluate((element: HTMLElement) => element.style.removeProperty('color'));
  return page.evaluate(
    async ({ data, fg }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (r: number, g: number, b: number) =>
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const text = luminance(fg[0], fg[1], fg[2]);
      let worst = Infinity;
      for (let index = 0; index < pixels.length; index += 4) {
        const bg = luminance(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!);
        const [hi, lo] = text > bg ? [text, bg] : [bg, text];
        worst = Math.min(worst, (hi + 0.05) / (lo + 0.05));
      }
      return Math.round(worst * 100) / 100;
    },
    { data: png.toString('base64'), fg: foreground },
  );
}

const loginViewports = [
  [2560, 1440],
  [2560, 1200],
  [1920, 1080],
  [1440, 900],
  [1366, 768],
  [1100, 800],
  [1024, 768],
  [901, 900],
] as const;

test('desktop login centres a larger slogan and form with readable contrast', async ({
  page,
}, testInfo) => {
  desktopOnly(testInfo.project.name);
  await signedOut(page);
  const measurements = [];
  for (const [width, height] of loginViewports) {
    await page.setViewportSize({ width, height });
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Đăng nhập Kho hàng IDOSI' })).toBeVisible();
    await settled(page);
    const m = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector)!;
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          fontSize: parseFloat(style.fontSize),
          textAlign: style.textAlign,
          color: style.color,
          // Content box width (inside border and padding).
          inner:
            element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        };
      };
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        visual: rect('.login-visual'),
        content: rect('.login-visual__content'),
        title: rect('.login-visual__title'),
        lead: rect('.login-visual__lead'),
        brand: rect('.login-brand'),
        foot: rect('.login-visual__foot'),
        panel: rect('.login-panel'),
        form: rect('.login-panel form'),
        heading: rect('.login-panel h1'),
        label: rect('.login-panel label'),
        input: rect('.login-panel input[name="login"]'),
        button: rect('.login-panel button[type="submit"]'),
        note: rect('.login-panel__note'),
      };
    });
    const label = `${width}x${height}`;
    const centre = (box: { x: number; width: number }) => box.x + box.width / 2;
    const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
    expect(m.scrollWidth, label).toBeLessThanOrEqual(m.clientWidth + 1);
    // Two columns: brand panel left, form wholly to its right.
    expect(m.form.x, label).toBeGreaterThan(m.visual.x + m.visual.width - 1);
    // Slogan block is centred in the left column on both axes.
    expect(Math.abs(centre(m.content) - centre(m.visual)), label).toBeLessThanOrEqual(2);
    expect(Math.abs(middle(m.content) - middle(m.visual)), label).toBeLessThanOrEqual(2);
    expect(m.title.textAlign, label).toBe('center');
    expect(m.title.color, label).toBe('rgb(255, 255, 255)');
    // Brand and footer keep clear space from the centred slogan.
    expect(m.content.y - (m.brand.y + m.brand.height), label).toBeGreaterThanOrEqual(24);
    expect(m.foot.y - (m.content.y + m.content.height), label).toBeGreaterThanOrEqual(24);
    // Slogan ≥ 20% larger than the old clamp(30px, 3.2vw, 46px).
    const oldTitle = Math.min(46, Math.max(30, width * 0.032));
    expect(m.title.fontSize, label).toBeGreaterThanOrEqual(oldTitle * 1.2);
    expect(m.title.fontSize, label).toBeLessThanOrEqual(64);
    expect(m.lead.fontSize, label).toBeGreaterThanOrEqual(16);
    expect(m.lead.fontSize, label).toBeLessThanOrEqual(18);
    // Form centred in the right column; vertically too while the page does not scroll.
    expect(Math.abs(centre(m.form) - centre(m.panel)), label).toBeLessThanOrEqual(2);
    if (m.scrollHeight <= height)
      expect(Math.abs(middle(m.form) - middle(m.panel)), label).toBeLessThanOrEqual(2);
    expect(m.form.width, label).toBeGreaterThanOrEqual(Math.min(540, m.panel.inner) - 1);
    expect(m.form.width, label).toBeLessThanOrEqual(560);
    expect(m.heading.fontSize, label).toBeGreaterThanOrEqual(34);
    expect(m.heading.fontSize, label).toBeLessThanOrEqual(40);
    expect(m.label.fontSize, label).toBeGreaterThanOrEqual(15);
    expect(m.input.fontSize, label).toBeGreaterThanOrEqual(16);
    expect(m.input.height, label).toBeGreaterThanOrEqual(52);
    expect(m.button.fontSize, label).toBeGreaterThanOrEqual(16);
    expect(m.button.height, label).toBeGreaterThanOrEqual(52);
    expect(m.button.height, label).toBeLessThanOrEqual(56);
    expect(m.note.fontSize, label).toBeGreaterThanOrEqual(14);
    expect(m.input.textAlign, label).not.toBe('center');
    const titleContrast = await minContrastBehind(page, '.login-visual__title', [255, 255, 255]);
    const leadContrast = await minContrastBehind(page, '.login-visual__lead', [238, 242, 255]);
    expect(titleContrast, `${label} slogan contrast`).toBeGreaterThanOrEqual(3);
    expect(leadContrast, `${label} description contrast`).toBeGreaterThanOrEqual(4.5);
    measurements.push({ viewport: label, ...m, titleContrast, leadContrast });
    await page.screenshot({
      path: testInfo.outputPath(`login-${label}.png`),
      animations: 'disabled',
    });
  }
  await saveMeasurements(testInfo, 'login-measurements', measurements);
});

test('short desktop login scrolls to every control instead of clipping', async ({
  page,
}, testInfo) => {
  desktopOnly(testInfo.project.name);
  await signedOut(page);
  await page.setViewportSize({ width: 1366, height: 540 });
  await page.goto('/login');
  const submit = page.getByRole('button', { name: 'Đăng nhập', exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  await page.locator('.login-panel__note').scrollIntoViewIfNeeded();
  await expect(page.locator('.login-panel__note')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
});

test('login keeps validation, server error, busy and success behaviour', async ({
  page,
}, testInfo) => {
  desktopOnly(testInfo.project.name);
  await signedOut(page);
  await mockLayoutData(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Protected route stores a safe return path before redirecting to login.
  await page.goto('/inventory');
  await expect(page).toHaveURL(/\/login$/);
  const username = page.getByLabel('Tên đăng nhập', { exact: true });
  const password = page.getByLabel('Mật khẩu', { exact: true });
  const toggle = page.getByRole('button', { name: 'Hiện mật khẩu' });
  const submit = page.getByRole('button', { name: 'Đăng nhập', exact: true });
  await expect(submit).toHaveAttribute('type', 'submit');

  // Keyboard order: username → password → reveal toggle → submit.
  await username.focus();
  await page.keyboard.press('Tab');
  await expect(password).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();

  // Reveal toggle is a plain button: it never submits and does not cover the typed text.
  let loginRequests = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let respond: (route: Route) => Promise<void> = (route) =>
    route.fulfill({
      status: 401,
      json: apiError('UNAUTHENTICATED', 'Tên đăng nhập hoặc mật khẩu không đúng.'),
    });
  await page.route('**/api/v1/auth/login', async (route) => {
    loginRequests += 1;
    await respond(route);
  });
  await password.fill('mat-khau-dai-de-kiem-tra-nut-con-mat');
  await toggle.click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: 'Ẩn mật khẩu' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const field = (await password.boundingBox())!;
  const eye = (await page.getByRole('button', { name: 'Ẩn mật khẩu' }).boundingBox())!;
  expect(field.x + field.width).toBeLessThanOrEqual(eye.x + 1);
  await page.getByRole('button', { name: 'Ẩn mật khẩu' }).click();
  await expect(password).toHaveAttribute('type', 'password');
  expect(loginRequests).toBe(0);

  // Whitespace-only username passes `required` but is rejected client-side.
  await username.fill('   ');
  await password.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Nhập đầy đủ tên đăng nhập và mật khẩu.');
  expect(loginRequests).toBe(0);

  // Server error message (long) stays inside the form; the submit button stays reachable.
  const longMessage = `Tên đăng nhập hoặc mật khẩu không đúng. ${'Vui lòng kiểm tra lại thông tin. '.repeat(12)}`;
  respond = (route) =>
    route.fulfill({ status: 401, json: apiError('UNAUTHENTICATED', longMessage.trim()) });
  await username.fill('kho.admin');
  await password.press('Enter');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Vui lòng kiểm tra lại thông tin.');
  const form = (await page.locator('.login-panel form').boundingBox())!;
  const alertBox = (await alert.boundingBox())!;
  expect(alertBox.x).toBeGreaterThanOrEqual(form.x - 1);
  expect(alertBox.x + alertBox.width).toBeLessThanOrEqual(form.x + form.width + 1);
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);

  // Pending request: button keeps its size, is disabled and cannot submit twice.
  const before = (await submit.boundingBox())!;
  respond = async (route) => {
    await pending;
    await page.unroute('**/api/v1/auth/session');
    await page.route('**/api/v1/auth/session', (r) =>
      r.fulfill({ json: { data: layoutAdminSession() } }),
    );
    await route.fulfill({ json: { data: layoutAdminSession() } });
  };
  const requestsBefore = loginRequests;
  await submit.click();
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveAttribute('aria-busy', 'true');
  const busy = (await submit.boundingBox())!;
  expect(Math.abs(busy.height - before.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(busy.width - before.width)).toBeLessThanOrEqual(1);
  await password.press('Enter');
  expect(loginRequests - requestsBefore).toBe(1);
  release();
  // Success returns to the protected route that sent the user to login.
  await expect(page).toHaveURL(/\/inventory$/);
  await expect(page.locator('.page-header h1')).toBeVisible();
});

test('desktop shell gutters, navigation typography and sign-out button', async ({
  page,
}, testInfo) => {
  desktopOnly(testInfo.project.name);
  await mockLayoutAdmin(page);
  await page.goto('/inventory');
  await expect(page.locator('.warehouse-stock-panel')).toBeVisible();
  const measurements = [];
  for (const [width, height] of [
    [2560, 1200],
    [1920, 1080],
    [1440, 900],
    [1366, 768],
    [1281, 800],
    [1280, 800],
    [1279, 800],
    [1100, 800],
    [1024, 768],
    [821, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    const m = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const size = (selector: string) =>
        parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize);
      const sidebar = box('.sidebar');
      const header = box('.page-header');
      const panel = box('.warehouse-stock-panel');
      const logout = document.querySelector<HTMLButtonElement>('.sidebar__logout')!;
      const logoutBox = logout.getBoundingClientRect();
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        sidebarRight: sidebar.right,
        header: { left: header.left, right: header.right },
        panel: { left: panel.left, right: panel.right, width: panel.width },
        pageTitle: size('.page-header h1'),
        groupTitle: size('.sidebar__group-title'),
        link: size('.sidebar__link'),
        profileName: size('.sidebar__profile-name'),
        profileScope: size('.sidebar__profile-scope'),
        logout: {
          fontSize: parseFloat(getComputedStyle(logout).fontSize),
          height: logoutBox.height,
          left: logoutBox.left,
          right: logoutBox.right,
          icon: logout.querySelector('svg')!.getBoundingClientRect().width,
          scrollWidth: logout.scrollWidth,
          clientWidth: logout.clientWidth,
        },
      };
    });
    const label = `${width}x${height}`;
    const gutter = expectedGutter(width)!;
    const leftGap = m.panel.left - m.sidebarRight;
    const rightGap = m.clientWidth - m.panel.right;
    expect(m.scrollWidth, label).toBeLessThanOrEqual(m.clientWidth + 1);
    expect(Math.abs(leftGap - gutter), label).toBeLessThanOrEqual(2);
    expect(Math.abs(rightGap - gutter), label).toBeLessThanOrEqual(2);
    expect(Math.abs(leftGap - rightGap), label).toBeLessThanOrEqual(2);
    // Header and full-width panel share both edges.
    expect(Math.abs(m.header.left - m.panel.left), label).toBeLessThanOrEqual(1);
    expect(Math.abs(m.header.right - m.panel.right), label).toBeLessThanOrEqual(1);
    if (width === 1440) expect(Math.abs(m.panel.width - 1108), label).toBeLessThanOrEqual(2);
    if (width === 1920) expect(Math.abs(m.panel.width - 1588), label).toBeLessThanOrEqual(2);
    // Hierarchy: page title > menu item > group title; all larger than the old 26/13/11px.
    if (width >= 1366) expect(m.pageTitle, label).toBeGreaterThanOrEqual(30);
    expect(m.pageTitle, label).toBeLessThanOrEqual(34);
    expect(m.link, label).toBeGreaterThanOrEqual(15);
    expect(m.link, label).toBeLessThanOrEqual(16);
    expect(m.groupTitle, label).toBeGreaterThanOrEqual(14);
    expect(m.groupTitle, label).toBeLessThanOrEqual(15);
    expect(m.pageTitle, label).toBeGreaterThan(m.link);
    expect(m.profileName, label).toBeGreaterThanOrEqual(15);
    expect(m.profileScope, label).toBeGreaterThanOrEqual(13);
    expect(m.logout.fontSize, label).toBeGreaterThanOrEqual(16);
    expect(m.logout.fontSize, label).toBeLessThanOrEqual(18);
    expect(m.logout.height, label).toBeGreaterThanOrEqual(44);
    expect(m.logout.icon, label).toBeGreaterThanOrEqual(20);
    expect(m.logout.icon, label).toBeLessThanOrEqual(22);
    expect(m.logout.right, label).toBeLessThanOrEqual(m.sidebarRight);
    expect(m.logout.scrollWidth, label).toBeLessThanOrEqual(m.logout.clientWidth);
    measurements.push({ viewport: label, gutter, leftGap, rightGap, ...m });
    if ([1366, 1440, 1920, 2560].includes(width))
      await page.screenshot({
        path: testInfo.outputPath(`shell-inventory-${label}.png`),
        animations: 'disabled',
      });
  }
  await saveMeasurements(testInfo, 'shell-measurements', measurements);
});

test('sign-out button: keyboard focus, busy state, error and success', async ({
  page,
}, testInfo) => {
  desktopOnly(testInfo.project.name);
  const longName = 'Nguyễn Thị Phương Thảo — Quản trị kho tổng khu vực miền Nam';
  await mockLayoutAdmin(page, longName);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/inventory');
  await expect(page.locator('.warehouse-stock-panel')).toBeVisible();
  const logout = page.getByRole('button', { name: 'Đăng xuất', exact: true });
  await expect(logout).toHaveCount(1);

  // Long names wrap inside the profile card without overflow.
  const name = page.locator('.sidebar__profile-name');
  await expect(name).toHaveText(longName);
  const nameBox = (await name.boundingBox())!;
  const profile = (await page.locator('.sidebar__profile').boundingBox())!;
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(profile.x + profile.width + 1);
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  // Keyboard: Tab from the last menu item reaches the button with a visible focus ring.
  await page.locator('.sidebar__link').last().focus();
  await page.keyboard.press('Tab');
  await expect(logout).toBeFocused();
  expect(await logout.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(
    'rgba(185, 28, 28',
  );

  // Busy: same box, disabled, label changes, no overlap with the account name.
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let logoutRequests = 0;
  await page.route('**/api/v1/auth/logout', async (route) => {
    logoutRequests += 1;
    await pending;
    await route.fulfill({
      status: 503,
      json: apiError('INTERNAL_ERROR', 'Máy chủ tạm thời không phản hồi. Vui lòng thử lại.'),
    });
  });
  const idle = (await logout.boundingBox())!;
  await page.keyboard.press('Enter');
  const busy = page.getByRole('button', { name: 'Đang đăng xuất…', exact: true });
  await expect(busy).toBeDisabled();
  const busyBox = (await busy.boundingBox())!;
  expect(Math.abs(busyBox.height - idle.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(busyBox.width - idle.width)).toBeLessThanOrEqual(1);
  expect(await busy.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const scope = (await page.locator('.sidebar__profile-scope').boundingBox())!;
  expect(busyBox.y).toBeGreaterThanOrEqual(scope.y + scope.height);
  release();
  // Failure keeps the session and reports the server message beside the button.
  await expect(page.locator('.sidebar__error')).toHaveText(
    'Máy chủ tạm thời không phản hồi. Vui lòng thử lại.',
  );
  await expect(logout).toBeEnabled();
  await expect(page).toHaveURL(/\/inventory$/);
  expect(logoutRequests).toBe(1);

  // Success: back to login; the protected route no longer opens with the revoked session.
  await page.unroute('**/api/v1/auth/logout');
  await page.route('**/api/v1/auth/logout', async (route) => {
    await page.unroute('**/api/v1/auth/session');
    await signedOut(page);
    await route.fulfill({ json: { data: { revoked: true } } });
  });
  await logout.focus();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/inventory');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Đăng nhập Kho hàng IDOSI' })).toBeVisible();
});

test('short and mobile sidebars keep the last menu item and sign-out reachable', async ({
  page,
}, testInfo) => {
  await mockLayoutAdmin(page);
  const mobile = testInfo.project.name !== 'desktop-1440';
  for (const [width, height] of mobile
    ? ([
        [390, 844],
        [360, 640],
      ] as const)
    : ([
        [1366, 520],
        [1280, 400],
      ] as const)) {
    await page.setViewportSize({ width, height });
    await page.goto('/inventory');
    await expect(page.locator('.page-header')).toBeVisible();
    if (mobile) {
      await page.getByRole('button', { name: 'Mở menu' }).click();
      await expect(page.locator('.sidebar')).toHaveClass(/sidebar--open/);
    }
    const lastLink = page.locator('.sidebar__link').last();
    await lastLink.scrollIntoViewIfNeeded();
    await expect(lastLink).toBeInViewport();
    const logout = page.getByRole('button', { name: 'Đăng xuất', exact: true });
    await logout.scrollIntoViewIfNeeded();
    await expect(logout).toBeInViewport({ ratio: 1 });
    expect((await logout.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (mobile) {
      // Mobile keeps its own 16/18px padding — the desktop gutter does not apply.
      const main = await page.locator('.app-main').evaluate((el) => ({
        left: parseFloat(getComputedStyle(el).paddingLeft),
        right: parseFloat(getComputedStyle(el).paddingRight),
      }));
      expect(main.left).toBeLessThanOrEqual(18);
      expect(main.right).toBeLessThanOrEqual(18);
    }
  }
});
