import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { revealContent } from '../lib/content-navigation';

type Target = 'page' | 'tab' | 'detail';
const Context = createContext<((element: HTMLElement, kind: Target) => void) | null>(null);

/** Per signed-in shell, never persisted across accounts. Destinations announce their own mount. */
export function RouteContentNavigation({ children }: { readonly children: ReactNode }) {
  const location = useLocation();
  const action = useNavigationType();
  const current = useRef<typeof location | null>(null);
  const previous = useRef<typeof location | null>(null);
  const positions = useRef(new Map<string, number>());
  const completed = useRef('');
  const restoreCleanup = useRef<(() => void) | null>(null);
  // Capture only an earlier visit. Native anchoring/layout can emit scroll while the initial
  // POP entry is still loading; those new samples must not turn it into a history restoration.
  const restorePosition = useMemo(
    () => (action === 'POP' ? positions.current.get(location.key) : undefined),
    [action, location.key],
  );
  const ready = useCallback(
    (element: HTMLElement, kind: Target) => {
      if (completed.current === location.key) return;
      // Child layout effects can run before the provider commits the new history entry.
      const prior = current.current?.key === location.key ? previous.current : current.current;
      const params = new URLSearchParams(location.search);
      const before = new URLSearchParams(prior?.search);
      const newPage = !prior || prior.pathname !== location.pathname;
      const tabChanged = ['tab', 'kt', 'ch'].some((key) => params.get(key) !== before.get(key));
      const detail = params.get('decision') || params.get('psl.open');
      const detailChanged = detail !== (before.get('decision') || before.get('psl.open'));
      const saved = restorePosition;
      if (saved !== undefined) {
        completed.current = location.key;
        // Lazy/data-loaded pages can initially be shorter than the saved offset. ResizeObserver
        // ends as soon as restoration succeeds; a user's next interaction cancels the intent.
        const restore = () => {
          window.scrollTo({ top: saved, behavior: 'instant' });
          return Math.abs(window.scrollY - saved) < 2;
        };
        if (!restore()) {
          const observer = new ResizeObserver(() => {
            if (restore()) cleanup();
          });
          const cleanup = () => {
            observer.disconnect();
            for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
              window.removeEventListener(event, cleanup);
            restoreCleanup.current = null;
          };
          observer.observe(document.body);
          for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
            window.addEventListener(event, cleanup, { once: true });
          restoreCleanup.current = cleanup;
        }
        return;
      }
      if (!newPage && !tabChanged && !detailChanged && location.hash === prior?.hash) {
        completed.current = location.key;
        return;
      }
      if (location.hash) {
        let id: string;
        try {
          id = decodeURIComponent(location.hash.slice(1));
        } catch {
          id = '';
        }
        const target = document.getElementById(id);
        if (target) {
          completed.current = location.key;
          revealContent(target);
        }
        // A data-backed anchor can mount after the page header. Its owner announces readiness.
        return;
      }
      if (detail && kind !== 'detail') return;
      if (
        kind === 'detail' ||
        (kind === 'tab' && (tabChanged || (newPage && params.has('tab')))) ||
        (kind === 'page' && newPage && !params.has('tab'))
      ) {
        completed.current = location.key;
        // Tab keyboard navigation retains roving focus on the active tab.
        const activeTab = kind === 'tab' && document.activeElement?.getAttribute('role') === 'tab';
        // Tabs owns horizontal visibility; arrow navigation must not move the document.
        if (!activeTab) revealContent(element);
      } else if (!newPage && !tabChanged && !detail && !location.hash) {
        completed.current = location.key; // filters and pagination are in-place operations
      }
    },
    [location, restorePosition],
  );
  useLayoutEffect(() => {
    const oldRestoration = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => {
      history.scrollRestoration = oldRestoration;
      restoreCleanup.current?.();
    };
  }, []);
  useLayoutEffect(() => {
    // Strict Mode replays cleanup/setup without navigating. Only a different history key
    // advances the prior location; cleanup must not consume a pending detail/hash intent.
    if (current.current?.key !== location.key) {
      previous.current = current.current;
      current.current = location;
    }
    const key = location.key;
    const remember = () => {
      positions.current.set(key, window.scrollY);
      if (positions.current.size > 100)
        positions.current.delete(positions.current.keys().next().value!);
    };
    const cancelPending = () => {
      completed.current = key;
      restoreCleanup.current?.();
    };
    window.addEventListener('scroll', remember, { passive: true });
    for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
      window.addEventListener(event, cancelPending, { capture: true, passive: true });
    return () => {
      window.removeEventListener('scroll', remember);
      for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
        window.removeEventListener(event, cancelPending, true);
      restoreCleanup.current?.();
    };
  }, [location]);
  return <Context.Provider value={ready}>{children}</Context.Provider>;
}

/** Called after real content mounts, never by skeletons, and again when an ID becomes ready. */
export function useRouteContentTarget<T extends HTMLElement>(
  ref: RefObject<T | null>,
  kind: Target,
  ready = true,
  identity = '',
) {
  const announce = useContext(Context);
  useLayoutEffect(() => {
    if (ready && ref.current) announce?.(ref.current, kind);
  }, [announce, identity, kind, ready, ref]);
}
