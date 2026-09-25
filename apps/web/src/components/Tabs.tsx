import clsx from 'clsx';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import './tabs.css';

export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: string;
}

export function tabId(idPrefix: string, tab: string): string {
  return `${idPrefix}-tab-${tab}`;
}

export function tabPanelId(idPrefix: string, tab: string): string {
  return `${idPrefix}-panel-${tab}`;
}

/** Arrow keys move between tabs (wrapping), Home/End jump to the ends; other keys do nothing. */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * WAI-ARIA tab list with roving focus. Only the active tab's panel should be mounted by the
 * caller; this component renders the tab bar alone so panels can be lazy and unmounted.
 */
export function Tabs<T extends string>({
  active,
  idPrefix,
  items,
  label,
  onChange,
  size = 'primary',
}: {
  readonly active: T;
  readonly idPrefix: string;
  readonly items: readonly TabItem<T>[];
  readonly label: string;
  readonly onChange: (tab: T) => void;
  readonly size?: 'primary' | 'secondary';
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTabIndex(event.key, index, items.length);
    if (next === null) return;
    event.preventDefault();
    const target = items[next];
    if (!target) return;
    refs.current.get(target.id)?.focus();
    onChange(target.id);
  };
  return (
    <div aria-label={label} className={clsx('tabs', `tabs--${size}`)} role="tablist">
      {items.map((item, index) => {
        const selected = item.id === active;
        return (
          <button
            aria-controls={tabPanelId(idPrefix, item.id)}
            aria-selected={selected}
            className={clsx('tabs__tab', selected && 'tabs__tab--active')}
            id={tabId(idPrefix, item.id)}
            key={item.id}
            onClick={() => {
              if (!selected) onChange(item.id);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            ref={(element) => {
              if (element) refs.current.set(item.id, element);
              else refs.current.delete(item.id);
            }}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  children,
  className,
  idPrefix,
  tab,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly idPrefix: string;
  readonly tab: string;
}) {
  return (
    <div
      aria-labelledby={tabId(idPrefix, tab)}
      className={clsx('tab-panel', className)}
      id={tabPanelId(idPrefix, tab)}
      role="tabpanel"
      tabIndex={0}
    >
      {children}
    </div>
  );
}
