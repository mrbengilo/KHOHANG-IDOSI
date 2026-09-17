import { afterEach, describe, expect, it, vi } from 'vitest';
import { onSessionExpired, reportUnauthorizedResponse } from './session-expiry';

describe('session expiry boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('broadcasts a protected 401 exactly while a listener is subscribed', () => {
    vi.stubGlobal('window', new EventTarget());
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);

    reportUnauthorizedResponse(401, '/stores?page=1');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    reportUnauthorizedResponse(401, '/products');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not treat invalid login credentials or other status codes as expiry', () => {
    vi.stubGlobal('window', new EventTarget());
    const listener = vi.fn();
    onSessionExpired(listener);

    reportUnauthorizedResponse(401, '/auth/login');
    reportUnauthorizedResponse(403, '/stores');

    expect(listener).not.toHaveBeenCalled();
  });

  it('treats a failed session refresh from a protected screen as expiry', () => {
    vi.stubGlobal('window', new EventTarget());
    const listener = vi.fn();
    onSessionExpired(listener);

    reportUnauthorizedResponse(401, '/auth/session?refresh=true');

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
