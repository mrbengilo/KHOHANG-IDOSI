/** Reveal vertically only: scrollIntoView also moves horizontal tables and their ancestors. */
export function revealContent(target: HTMLElement | null, focus = true): void {
  if (!target?.isConnected) return;
  if (focus) {
    if (!target.matches('a[href], button, input, select, textarea, [tabindex]'))
      target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  const margin = Math.max(
    Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0,
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--content-reveal-offset'),
    ) || 16,
  );
  let parent = target.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const style = getComputedStyle(parent);
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1) {
      parent.scrollTo({
        top:
          parent.scrollTop +
          target.getBoundingClientRect().top -
          parent.getBoundingClientRect().top -
          margin,
        behavior: 'instant',
      });
    }
    parent = parent.parentElement;
  }
  // Immediate movement is intentional: deterministic keyboard focus, including reduced motion.
  window.scrollTo({
    top: window.scrollY + target.getBoundingClientRect().top - margin,
    behavior: 'instant',
  });
}

export function targetSetKey(targets: readonly { sourceId: string; productId: string }[]): string {
  return targets
    .map(({ sourceId, productId }) => `${sourceId}:${productId}`)
    .sort()
    .join('|');
}
