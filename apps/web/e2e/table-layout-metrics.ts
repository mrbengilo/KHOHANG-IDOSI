import type { Page } from '@playwright/test';

/** Viewports from docs/responsive-table-layout-audit.md (desktop, tablet, mobile, breakpoints). */
export const tableLayoutViewports = [
  [1366, 768],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
  [1024, 768],
  [768, 1024],
  [360, 800],
  [390, 844],
  [412, 915],
  [819, 900],
  [820, 900],
  [821, 900],
] as const;

export interface TableLayoutMeasurement {
  readonly id: string;
  readonly headers: readonly string[];
  readonly columns: number;
  readonly rows: number;
  readonly mode: 'table' | 'cards';
  readonly tableWidth: number;
  readonly visibleLeft: number;
  readonly visibleWidth: number;
  readonly containerLeft: number;
  readonly containerWidth: number;
  readonly gapLeft: number;
  readonly gapRight: number;
  readonly scrollport: string | null;
  readonly overflowing: boolean;
  readonly firstColumnReachable: boolean;
  readonly lastColumnReachable: boolean;
  readonly misaligned: readonly string[];
  readonly text: string;
}

export interface PageTableLayout {
  readonly viewport: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly tables: readonly TableLayoutMeasurement[];
}

/**
 * Measures every rendered table in the workspace and in open dialogs.
 * The visible block is the table itself while it fits, or its scrollport while it scrolls;
 * gaps are taken against the content box of the block's direct container.
 */
export async function measureTableLayout(page: Page): Promise<PageTableLayout> {
  return page.evaluate(() => {
    const px = (value: string) => Number.parseFloat(value) || 0;
    const describe = (element: Element) =>
      element.tagName.toLowerCase() +
      (element.id ? `#${element.id}` : '') +
      Array.from(element.classList)
        .slice(0, 3)
        .map((name) => `.${name}`)
        .join('');
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    };
    const rightish = new Set(['right', 'end', 'center', '-webkit-right', '-webkit-center']);
    const pushedRight = new Set(['flex-end', 'end', 'right']);
    const tables = Array.from(
      document.querySelectorAll<HTMLTableElement>('.app-main table, [role="dialog"] table'),
    ).filter(visible);
    return {
      viewport: innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      tables: tables.map((table) => {
        let scrollport: HTMLElement | null = null;
        for (
          let node = table.parentElement, depth = 0;
          node && depth < 2;
          node = node.parentElement, depth += 1
        ) {
          if (['auto', 'scroll'].includes(getComputedStyle(node).overflowX)) {
            scrollport = node;
            break;
          }
        }
        const overflowing = scrollport
          ? scrollport.scrollWidth > scrollport.clientWidth + 1
          : false;
        const mode = getComputedStyle(table).display === 'table' ? 'table' : 'cards';
        const visibleBox = (overflowing ? scrollport! : table).getBoundingClientRect();
        const container = (scrollport ?? table).parentElement!;
        const containerStyle = getComputedStyle(container);
        const containerBox = container.getBoundingClientRect();
        const containerLeft =
          containerBox.left + px(containerStyle.borderLeftWidth) + px(containerStyle.paddingLeft);
        const containerRight =
          containerBox.right -
          px(containerStyle.borderRightWidth) -
          px(containerStyle.paddingRight);
        const headerRow = table.querySelector('thead tr:last-child');
        const headers = Array.from(headerRow?.children ?? []).map(
          (cell) => cell.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        );
        const misaligned: string[] = [];
        for (const cell of Array.from(table.querySelectorAll<HTMLElement>('th, td'))) {
          if (!visible(cell)) continue;
          const style = getComputedStyle(cell);
          if (rightish.has(style.textAlign))
            misaligned.push(`${describe(cell)} text-align:${style.textAlign}`);
          for (const child of Array.from(cell.querySelectorAll<HTMLElement>('*'))) {
            if (!visible(child) || child.closest('button, [role="button"], .badge')) continue;
            const childStyle = getComputedStyle(child);
            const flex = childStyle.display.includes('flex');
            const column = childStyle.flexDirection.startsWith('column');
            if (
              (flex && !column && pushedRight.has(childStyle.justifyContent)) ||
              (flex && column && pushedRight.has(childStyle.alignItems)) ||
              ((child.matches('input, select, textarea') || child.textContent?.trim()) &&
                rightish.has(childStyle.textAlign))
            )
              misaligned.push(`${describe(cell)} > ${describe(child)}`);
          }
          if (misaligned.length > 12) break;
        }
        const firstCell = headerRow?.firstElementChild ?? table.querySelector('tr > *');
        const lastCell = headerRow?.lastElementChild ?? table.querySelector('tr > *:last-child');
        let firstColumnReachable = true;
        let lastColumnReachable = true;
        if (scrollport && mode === 'table' && firstCell && lastCell) {
          const port = scrollport.getBoundingClientRect();
          const previous = scrollport.scrollLeft;
          scrollport.scrollLeft = 0;
          firstColumnReachable = firstCell.getBoundingClientRect().left >= port.left - 1;
          scrollport.scrollLeft = scrollport.scrollWidth;
          const last = lastCell.getBoundingClientRect();
          lastColumnReachable = last.right <= port.right + 1 && last.left >= port.left - 1;
          scrollport.scrollLeft = previous;
        }
        const label =
          table.getAttribute('aria-label') ??
          table.closest('[aria-label]')?.getAttribute('aria-label') ??
          headers.slice(0, 3).join(' / ');
        return {
          id: `${label} [${describe(table)}]`,
          headers,
          columns: headers.length || (table.querySelector('tr')?.children.length ?? 0),
          rows: table.querySelectorAll('tbody tr').length,
          mode,
          tableWidth: Math.round(table.getBoundingClientRect().width * 10) / 10,
          visibleLeft: Math.round(visibleBox.left * 10) / 10,
          visibleWidth: Math.round(visibleBox.width * 10) / 10,
          containerLeft: Math.round(containerLeft * 10) / 10,
          containerWidth: Math.round((containerRight - containerLeft) * 10) / 10,
          gapLeft: Math.round((visibleBox.left - containerLeft) * 10) / 10,
          gapRight: Math.round((containerRight - visibleBox.right) * 10) / 10,
          scrollport: scrollport ? describe(scrollport) : null,
          overflowing,
          firstColumnReachable,
          lastColumnReachable,
          misaligned,
          text: table.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        } satisfies TableLayoutMeasurement;
      }),
    };
  });
}

/** Human-readable violations of the centring, overflow, reachability and alignment rules. */
export function tableLayoutViolations(layout: PageTableLayout): string[] {
  const problems: string[] = [];
  if (layout.scrollWidth > layout.clientWidth + 1)
    problems.push(`page overflow ${layout.scrollWidth} > ${layout.clientWidth}`);
  for (const table of layout.tables) {
    if (Math.abs(table.gapLeft - table.gapRight) > 2)
      problems.push(`${table.id}: not centred (left ${table.gapLeft}, right ${table.gapRight})`);
    if (table.gapLeft < -1 || table.gapRight < -1)
      problems.push(`${table.id}: escapes its container (${table.gapLeft}/${table.gapRight})`);
    if (!table.firstColumnReachable || !table.lastColumnReachable)
      problems.push(`${table.id}: first/last column not reachable by scrolling`);
    if (table.misaligned.length)
      problems.push(`${table.id}: not left aligned: ${table.misaligned.slice(0, 4).join('; ')}`);
  }
  return problems;
}
