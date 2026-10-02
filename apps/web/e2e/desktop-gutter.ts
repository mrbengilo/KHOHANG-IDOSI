/**
 * Lề trái/phải vùng làm việc desktop (styles.css `--content-gutter`): 3 × 18px = 54px từ
 * 1280px; 821–1279px tăng tuyến tính 18 → 54px; ≤820px là bố cục mobile (null).
 */
export const BASE_GUTTER = 18;
export const DESKTOP_GUTTER = BASE_GUTTER * 3;

export function expectedGutter(viewportWidth: number): number | null {
  if (viewportWidth <= 820) return null;
  const fluid = BASE_GUTTER + (viewportWidth - 821) * 0.0785;
  return Math.min(DESKTOP_GUTTER, Math.max(BASE_GUTTER, fluid));
}
