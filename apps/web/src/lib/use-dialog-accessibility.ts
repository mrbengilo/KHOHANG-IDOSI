import { useEffect, useRef, type RefObject } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  );
}

function focusElement(element: HTMLElement | null): boolean {
  if (!element?.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') {
    return false;
  }

  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

function restoreDialogFocus(previousFocus: HTMLElement | null): void {
  if (focusElement(previousFocus)) return;

  const fallback = [
    '[data-dialog-focus-fallback]',
    'main h1',
    '[role="main"] h1',
    'main',
    '[role="main"]',
  ]
    .map((selector) => document.querySelector<HTMLElement>(selector))
    .find((element): element is HTMLElement => element !== null);
  if (!fallback) return;

  const previousTabIndex = fallback.getAttribute('tabindex');
  if (previousTabIndex === null) fallback.tabIndex = -1;
  const focused = focusElement(fallback);
  if (previousTabIndex === null) {
    if (focused) {
      fallback.addEventListener('blur', () => fallback.removeAttribute('tabindex'), { once: true });
    } else {
      fallback.removeAttribute('tabindex');
    }
  }
}

/** Keeps keyboard focus inside an open modal and restores it to its trigger on close. */
export function useDialogAccessibility<T extends HTMLElement = HTMLElement>(
  onClose: (() => void) | undefined,
): RefObject<T | null> {
  const panelRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;

    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !panel.contains(activeElement)) {
      const explicitInitialFocus = panel.querySelector<HTMLElement>(
        '[data-dialog-initial-focus], [autofocus]',
      );
      const editableInitialFocus = panel.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"]',
      );
      const initialFocus =
        explicitInitialFocus ?? editableInitialFocus ?? focusableElements(panel)[0] ?? panel;
      initialFocus.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements(panel);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const focused = document.activeElement;
      const focusedIndex = focused instanceof HTMLElement ? focusable.indexOf(focused) : -1;
      if (event.shiftKey && (focused === first || focusedIndex === -1)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (focused === last || focusedIndex === -1)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.classList.add('dialog-open');

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.classList.remove('dialog-open');
      restoreDialogFocus(previousFocusRef.current);
    };
  }, []);

  return panelRef;
}
