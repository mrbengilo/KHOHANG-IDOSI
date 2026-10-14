import type { Page } from '@playwright/test';

/**
 * Table heading typography (docs/reshare-htkd-ui-status-history.md): column headers, table
 * captions shown on screen and the mobile card labels (td::before from data-label) are sentence
 * case and bold. Abbreviations and proper names keep their own spelling. Measured on the rendered
 * DOM (computed styles and the real text), not on source strings.
 */
export interface HeadingIssue {
  readonly kind: 'header' | 'card-label';
  readonly text: string;
  readonly problem: string;
}

export async function tableHeadingIssues(page: Page): Promise<HeadingIssue[]> {
  return page.evaluate(() => {
    const ABBREVIATIONS = new Set([
      'RE',
      'SKU',
      'VAT',
      'HTKD',
      'IDOSI',
      'ID',
      'STT',
      'KG',
      'VND',
      'VNĐ',
      'P0A',
      'P1',
      'P2',
      'P3',
    ]);
    const PROPER_NAMES = new Set(['Reshare', 'IDOSI', 'Admin']);
    const words = (text: string) =>
      text.split(/[\s/·,()+\-–:;.→=]+/u).filter((word) => /\p{L}/u.test(word));
    const problemOf = (raw: string): string | null => {
      const text = raw.replace(/\s+/gu, ' ').trim();
      if (!text) return null;
      const list = words(text);
      for (const word of list) {
        const letters = word.replace(/[^\p{L}]/gu, '');
        if (letters.length > 1 && letters === letters.toLocaleUpperCase('vi-VN')) {
          if (!ABBREVIATIONS.has(word)) return `chữ in hoa: ${word}`;
        }
      }
      const first = text.match(/\p{L}/u)?.[0];
      if (first && first !== first.toLocaleUpperCase('vi-VN')) return 'không viết hoa chữ đầu';
      for (const word of list.slice(1)) {
        const letters = word.replace(/[^\p{L}]/gu, '');
        if (
          letters.length > 1 &&
          letters[0] === letters[0]!.toLocaleUpperCase('vi-VN') &&
          letters !== letters.toLocaleUpperCase('vi-VN') &&
          !PROPER_NAMES.has(word)
        ) {
          return `Viết Hoa Mỗi Từ: ${word}`;
        }
      }
      return null;
    };
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const issues: { kind: 'header' | 'card-label'; text: string; problem: string }[] = [];
    for (const cell of Array.from(document.querySelectorAll('.app-main thead th'))) {
      if (!visible(cell)) continue;
      const style = getComputedStyle(cell);
      const text = cell.textContent ?? '';
      if (Number(style.fontWeight) < 700)
        issues.push({ kind: 'header', text, problem: `font-weight ${style.fontWeight}` });
      if (style.textTransform !== 'none')
        issues.push({ kind: 'header', text, problem: `text-transform ${style.textTransform}` });
      // Every visible child keeps the header's weight (icons, links, sort buttons).
      for (const child of Array.from(cell.querySelectorAll('*'))) {
        if (!visible(child) || !child.textContent?.trim()) continue;
        if (Number(getComputedStyle(child).fontWeight) < 700)
          issues.push({ kind: 'header', text, problem: 'nội dung con không in đậm' });
      }
      const problem = problemOf(text);
      if (problem) issues.push({ kind: 'header', text, problem });
    }
    for (const cell of Array.from(document.querySelectorAll('.app-main td[data-label]'))) {
      if (!visible(cell)) continue;
      const label = getComputedStyle(cell, '::before');
      if (label.content === 'none' || label.content === 'normal' || label.display === 'none')
        continue;
      const text = cell.getAttribute('data-label') ?? '';
      if (Number(label.fontWeight) < 700)
        issues.push({ kind: 'card-label', text, problem: `font-weight ${label.fontWeight}` });
      if (label.textTransform !== 'none')
        issues.push({ kind: 'card-label', text, problem: `text-transform ${label.textTransform}` });
      const problem = problemOf(text);
      if (problem) issues.push({ kind: 'card-label', text, problem });
    }
    const seen = new Set<string>();
    return issues.filter((issue) => {
      const key = `${issue.kind}|${issue.text}|${issue.problem}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}
