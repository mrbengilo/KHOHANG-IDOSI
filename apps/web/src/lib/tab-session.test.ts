import { afterEach, describe, expect, it, vi } from 'vitest';
import { addTabSessionHeader } from './tab-session';

afterEach(() => vi.unstubAllGlobals());

describe('tab session selector', () => {
  it('reuses its selector on reload and gives a newly opened tab a different selector', () => {
    let nextId = 1;
    const browserTab = () => {
      const values = new Map<string, string>();
      return {
        crypto: {
          randomUUID: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
        },
        sessionStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
        },
      };
    };

    vi.stubGlobal('window', browserTab());
    const first = new Headers();
    addTabSessionHeader(first);
    const reload = new Headers();
    addTabSessionHeader(reload);
    expect(reload.get('x-idosi-tab-id')).toBe(first.get('x-idosi-tab-id'));

    vi.stubGlobal('window', browserTab());
    const second = new Headers();
    addTabSessionHeader(second);
    expect(second.get('x-idosi-tab-id')).not.toBe(first.get('x-idosi-tab-id'));
  });
});
