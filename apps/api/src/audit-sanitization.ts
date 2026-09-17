const SENSITIVE_KEY_PATTERN =
  /(?:password|passphrase|secret|token|authorization|cookie|credential|private[_-]?key)/iu;

/** Defense-in-depth for legacy/custom audit metadata before it leaves the API boundary. */
export function sanitizeAuditObject(value: unknown): Record<string, unknown> | null {
  const sanitized = sanitizeAuditValue(value);
  if (typeof sanitized !== 'object' || sanitized === null || Array.isArray(sanitized)) return null;
  return sanitized as Record<string, unknown>;
}

function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item));
  if (typeof value !== 'object' || value === null) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    sanitized[key] = sanitizeAuditValue(item);
  }
  return sanitized;
}
