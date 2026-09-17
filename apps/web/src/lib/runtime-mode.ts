export function shouldEnableMockMode(
  dev: boolean,
  mode: string,
  configuredValue: string | undefined,
): boolean {
  const mockCapableMode = dev || mode === 'test' || mode === 'e2e';
  return mockCapableMode && configuredValue !== 'false';
}
