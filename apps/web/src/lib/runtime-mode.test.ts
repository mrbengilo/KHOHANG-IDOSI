import { describe, expect, it } from 'vitest';
import { shouldEnableMockMode } from './runtime-mode';

describe('mock runtime isolation', () => {
  it('cannot enable mock data in a production build', () => {
    expect(shouldEnableMockMode(false, 'production', 'true')).toBe(false);
  });

  it('supports explicit developer and e2e builds', () => {
    expect(shouldEnableMockMode(true, 'development', undefined)).toBe(true);
    expect(shouldEnableMockMode(false, 'e2e', 'true')).toBe(true);
    expect(shouldEnableMockMode(true, 'development', 'false')).toBe(false);
  });
});
