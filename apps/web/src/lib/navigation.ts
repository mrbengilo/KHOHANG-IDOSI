export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login#')) return '/';
  return value;
}
