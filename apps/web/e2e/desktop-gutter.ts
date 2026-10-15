/**
 * Lề trái/phải vùng làm việc desktop (styles.css `--content-gutter`). Nền: lề cũ (18 → 54px)
 * trừ 8px vì sidebar rộng thêm 16px, trong khoảng 18–46px, nên vùng làm việc giữ nguyên. Màn
 * rộng: phần dư ngoài vùng làm việc 1506px (bảng rộng nhất) dồn vào lề, tối đa 162px (3 × lề
 * 54px trước đây, đạt từ 2070px). ≤820px là bố cục mobile (null).
 */
export const BASE_GUTTER = 18;
/** Lề desktop của bản trước; lề màn rộng bây giờ gấp 3. */
export const PREVIOUS_GUTTER = BASE_GUTTER * 3;
export const DESKTOP_GUTTER = PREVIOUS_GUTTER * 3;
const LAPTOP_GUTTER_MAX = 46;
/** styles.css `--sidebar-width` và `--workspace-min`. */
export const SIDEBAR_WIDTH = 240;
export const WORKSPACE_MIN = 1506;

export function expectedGutter(viewportWidth: number): number | null {
  if (viewportWidth <= 820) return null;
  const laptop = Math.min(
    LAPTOP_GUTTER_MAX,
    Math.max(BASE_GUTTER, 10 + (viewportWidth - 821) * 0.0785),
  );
  const wide = Math.min(DESKTOP_GUTTER, (viewportWidth - SIDEBAR_WIDTH - WORKSPACE_MIN) / 2);
  return Math.max(laptop, wide);
}

/** Bề rộng một panel full-width giữa hai lề (không có thanh cuộn cổ điển). */
export function expectedPanelWidth(viewportWidth: number): number {
  return viewportWidth - SIDEBAR_WIDTH - 2 * expectedGutter(viewportWidth)!;
}
