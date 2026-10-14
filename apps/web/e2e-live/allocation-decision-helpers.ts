import { expect, type Page } from '@playwright/test';

/**
 * The store side accepts the published result that contains `productName` from the persistent
 * notice, exactly as a person would; acceptance is what releases the shipment to /receive.
 */
export async function acceptAllocationResultFromNotice(page: Page, productName: string) {
  await page.goto('/');
  const notice = page.getByRole('complementary', { name: /Có kết quả phân bổ cần xử lý/u });
  await expect(notice).toBeVisible();
  const item = notice.getByRole('listitem').filter({ hasText: productName });
  await expect(item).toHaveCount(1);
  await item.getByRole('link', { name: /Xem chi tiết phiếu/u }).click();
  await expect(page).toHaveURL(/\/allocations\?decision=/);
  const panel = page.locator('.allocation-decision');
  await expect(panel).toContainText(productName);
  await expect(panel).toContainText('Chờ xác nhận');
  await panel.getByRole('button', { name: 'Xác nhận phân bổ' }).click();
  await expect(panel.locator('.allocation-decision__status > .badge')).toHaveText(
    'Đã xác nhận phân bổ',
  );
  await expect(panel).toContainText('Đã giao đi, chờ cửa hàng khai nhận');
}
