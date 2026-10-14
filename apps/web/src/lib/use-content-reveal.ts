import { useLayoutEffect, useRef } from 'react';
import { revealContent } from './content-navigation';

/** Opt-in for an inline editor/detail mounted by an explicit open action. */
export function useContentReveal<T extends HTMLElement>(identity = '', focus = true) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const target = ref.current;
    const trigger = document.activeElement;
    revealContent(target, focus);
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        revealContent(trigger);
      }
    };
  }, [identity, focus]);
  return ref;
}
