import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from './Button';

export interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly danger?: boolean;
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

export function Dialog({
  children,
  danger = false,
  description,
  footer,
  onClose,
  open,
  title,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  if (
    open &&
    !wasOpenRef.current &&
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement
  ) {
    previousFocusRef.current = document.activeElement;
  }
  wasOpenRef.current = open;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    const initialFocus =
      panel?.querySelector<HTMLElement>('input, select, textarea') ??
      panel?.querySelector<HTMLElement>('button');
    initialFocus?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = [
        ...panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
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
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('idosi-dialog-open');

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('idosi-dialog-open');
      restoreDialogFocus(previousFocusRef.current);
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="idosi-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="idosi-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="idosi-dialog__header">
          <div>
            <span className={danger ? 'idosi-dialog__eyebrow is-danger' : 'idosi-dialog__eyebrow'}>
              {danger ? 'Hành động nhạy cảm' : 'Xác nhận thao tác'}
            </span>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <Button variant="ghost" size="sm" aria-label="Đóng hộp thoại" onClick={onClose}>
            ×
          </Button>
        </header>
        {children ? <div className="idosi-dialog__body">{children}</div> : null}
        {footer ? <footer className="idosi-dialog__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
