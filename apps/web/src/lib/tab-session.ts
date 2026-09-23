const TAB_ID_STORAGE_KEY = 'idosi-auth-tab-id:v1';
const TAB_SESSION_HEADER = 'x-idosi-tab-id';
const TAB_ID_PATTERN = /^[a-f0-9]{32}$/u;

/** A tab identifier selects its HttpOnly cookie; it is never an authentication token. */
export function addTabSessionHeader(headers: Headers): void {
  if (typeof window === 'undefined') return;
  let tabId = window.sessionStorage.getItem(TAB_ID_STORAGE_KEY);
  if (!tabId || !TAB_ID_PATTERN.test(tabId)) {
    tabId = window.crypto.randomUUID().replaceAll('-', '');
    window.sessionStorage.setItem(TAB_ID_STORAGE_KEY, tabId);
  }
  headers.set(TAB_SESSION_HEADER, tabId);
}
