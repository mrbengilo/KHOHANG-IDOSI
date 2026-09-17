import { describe, expect, it } from 'vitest';

import { auditQueryFromFilters, formatAuditJson, type AuditFilterDraft } from './AuditLogPage';

const emptyFilters: AuditFilterDraft = {
  action: '',
  actorAccountId: '',
  createdFrom: '',
  createdTo: '',
  entityId: '',
  entityType: '',
  requestId: '',
};

describe('audit log UI helpers', () => {
  it('normalizes populated filters and omits empty fields', () => {
    const result = auditQueryFromFilters(
      {
        ...emptyFilters,
        action: '  ACCOUNT_PASSWORD_RESET ',
        entityType: ' user ',
        requestId: ' request-1 ',
      },
      2,
    );
    expect(result.error).toBeNull();
    expect(result.query).toEqual({
      action: 'ACCOUNT_PASSWORD_RESET',
      entityType: 'user',
      page: 2,
      pageSize: 30,
      requestId: 'request-1',
    });
  });

  it('rejects reversed time windows before calling the backend', () => {
    const result = auditQueryFromFilters(
      {
        ...emptyFilters,
        createdFrom: '2026-09-18T12:00',
        createdTo: '2026-09-17T12:00',
      },
      1,
    );
    expect(result.query).toBeNull();
    expect(result.error).toContain('không được trước');
  });

  it('renders immutable snapshots as readable JSON', () => {
    expect(formatAuditJson({ sessionsRevoked: 2, status: 'LOCKED' })).toContain(
      '"sessionsRevoked": 2',
    );
    expect(formatAuditJson(null)).toBe('Không có');
  });
});
