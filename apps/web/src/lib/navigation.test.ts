import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './navigation';

describe('safeReturnPath', () => {
  it('preserves an internal path including its query and hash', () => {
    expect(safeReturnPath('/catalog?status=ACTIVE#table')).toBe('/catalog?status=ACTIVE#table');
  });

  it('rejects external and recursive login targets', () => {
    expect(safeReturnPath('//example.com')).toBe('/');
    expect(safeReturnPath('https://example.com')).toBe('/');
    expect(safeReturnPath('/login?again=1')).toBe('/');
  });
});
