/**
 * Lề trái/phải vùng làm việc desktop (styles.css `--content-gutter`), theo bậc để bảng không
 * xuống dòng thêm: 162px (3 × lề 54px cũ) từ 2070px; dưới đó tối đa 108px (2 ×) khi vùng làm
 * việc còn đủ 1506px (bảng rộng nhất); hẹp hơn là lề lớn nhất bảng vẫn vừa, không dưới lề nền =
 * lề cũ (18 → 54px) trừ 8px vì sidebar rộng thêm 16px. ≤820px là bố cục mobile (null).
 */
export const BASE_GUTTER = 18;
/** Lề desktop của bản trước; lề màn rộng bây giờ gấp 3. */
export const PREVIOUS_GUTTER = BASE_GUTTER * 3;
export const DESKTOP_GUTTER = PREVIOUS_GUTTER * 3;
export const DOUBLE_GUTTER = PREVIOUS_GUTTER * 2;
/** styles.css `@media (min-width: 2070px)`: bậc gấp 3. */
export const TRIPLE_GUTTER_FROM = 2070;
const LAPTOP_GUTTER_MAX = 46;
/** styles.css `--sidebar-width` và `--workspace-min`. */
export const SIDEBAR_WIDTH = 240;
export const WORKSPACE_MIN = 1506;

export function expectedGutter(viewportWidth: number): number | null {
  if (viewportWidth <= 820) return null;
  if (viewportWidth >= TRIPLE_GUTTER_FROM) return DESKTOP_GUTTER;
  const laptop = Math.min(
    LAPTOP_GUTTER_MAX,
    Math.max(BASE_GUTTER, 10 + (viewportWidth - 821) * 0.0785),
  );
  const wide = Math.min(DOUBLE_GUTTER, (viewportWidth - SIDEBAR_WIDTH - WORKSPACE_MIN) / 2);
  return Math.max(laptop, wide);
}

/** Bề rộng một panel full-width giữa hai lề (không có thanh cuộn cổ điển). */
export function expectedPanelWidth(viewportWidth: number): number {
  return viewportWidth - SIDEBAR_WIDTH - 2 * expectedGutter(viewportWidth)!;
}
