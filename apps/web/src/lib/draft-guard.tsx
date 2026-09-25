import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from 'react';

type Report = (id: string, dirty: boolean) => void;

const DraftContext = createContext<Report>(() => undefined);

/**
 * Declares that a form holds unsaved input. Outside any `DraftScope` it does nothing, so forms
 * reused on screens without a guard keep their current behavior.
 */
export function useDraftGuard(dirty: boolean): void {
  const id = useId();
  const report = useContext(DraftContext);
  useEffect(() => {
    report(id, dirty);
    return () => report(id, false);
  }, [dirty, id, report]);
}

/** Pure bookkeeping of which forms in a scope currently hold a draft. */
export function nextDraftIds(
  current: ReadonlySet<string>,
  id: string,
  dirty: boolean,
): ReadonlySet<string> {
  if (current.has(id) === dirty) return current;
  const next = new Set(current);
  if (dirty) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * Collects the drafts of its subtree, tells its owner whether any exists, and forwards that to
 * an enclosing scope, so a tab bar several levels up can refuse to discard a draft silently.
 */
export function DraftScope({
  children,
  onDirtyChange,
}: {
  readonly children: ReactNode;
  readonly onDirtyChange?: (dirty: boolean) => void;
}) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback<Report>(
    (id, dirty) => setIds((current) => nextDraftIds(current, id, dirty)),
    [],
  );
  const dirty = ids.size > 0;
  useDraftGuard(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  return <DraftContext.Provider value={report}>{children}</DraftContext.Provider>;
}

/** Asks the browser to confirm a reload or close while a draft exists. */
export function useBeforeUnloadWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);
}
