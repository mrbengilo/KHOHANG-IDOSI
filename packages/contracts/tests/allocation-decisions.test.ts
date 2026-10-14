import { describe, expect, it } from 'vitest';

import {
  AllocationDecisionDetailSchema,
  AllocationDecisionSchema,
  ListAllocationDecisionsQuerySchema,
  ListSessionDocumentsQuerySchema,
  RespondAllocationDecisionRequestSchema,
  SessionDocumentSchema,
} from '../src/index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const decision = {
  id: ID,
  allocationRunId: ID,
  runVersion: 1,
  sessionId: ID,
  sessionCode: 'PDH-000001',
  businessDate: '2026-10-05',
  storeId: ID,
  status: 'PENDING',
  version: 1,
  grantedQuantity: 3,
  origin: 'ALLOCATION_RUN',
  canRespond: true,
  respondedAt: null,
  respondedByAccountId: null,
  respondedByName: null,
  reason: null,
  createdAt: '2026-10-05T02:00:00.000Z',
  updatedAt: '2026-10-05T02:00:00.000Z',
  lines: [{ productId: ID, requestedQuantity: 4, allocatedQuantity: 3, waitlistedQuantity: 1 }],
  carried: [],
  heldQuantity: 0,
  releasedQuantity: 0,
  shipment: null,
} as const;

describe('allocation decision contracts', () => {
  it('accepts only an action and the seen version; REJECT parses only to be refused (409)', () => {
    expect(
      RespondAllocationDecisionRequestSchema.parse({ action: 'ACCEPT', expectedVersion: 1 }),
    ).toEqual({ action: 'ACCEPT', expectedVersion: 1 });
    expect(
      RespondAllocationDecisionRequestSchema.parse({ action: 'WAITLIST', expectedVersion: 2 }),
    ).toEqual({ action: 'WAITLIST', expectedVersion: 2 });
    expect(
      RespondAllocationDecisionRequestSchema.parse({
        action: 'REJECT',
        expectedVersion: 1,
        reason: '  đủ hàng  ',
      }),
    ).toEqual({ action: 'REJECT', expectedVersion: 1, reason: 'đủ hàng' });
    for (const invalid of [
      { action: 'ACCEPT' },
      { action: 'MAYBE', expectedVersion: 1 },
      { action: 'ACCEPT', expectedVersion: 0 },
      { action: 'ACCEPT', expectedVersion: 1.5 },
      { action: 'ACCEPT', expectedVersion: 1, reason: 'ok' },
      { action: 'WAITLIST', expectedVersion: 1, reason: 'ok' },
      { action: 'WAITLIST', expectedVersion: 1, quantities: [{ productId: ID, quantity: 1 }] },
      { action: 'REJECT', expectedVersion: 1, reason: 'x'.repeat(501) },
      // The client can never choose quantities, store or sources.
      { action: 'ACCEPT', expectedVersion: 1, storeId: ID },
      { action: 'ACCEPT', expectedVersion: 1, quantities: [{ productId: ID, quantity: 9 }] },
    ]) {
      expect(RespondAllocationDecisionRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('keeps the run version apart from the command version and is strict', () => {
    expect(AllocationDecisionSchema.parse(decision)).toEqual(decision);
    expect(AllocationDecisionSchema.safeParse({ ...decision, extra: true }).success).toBe(false);
    expect(AllocationDecisionSchema.safeParse({ ...decision, status: 'DONE' }).success).toBe(false);
    expect(AllocationDecisionDetailSchema.parse({ ...decision, sources: [] }).sources).toEqual([]);
  });

  it('describes revoked and actionable goods only as opt-in fields', () => {
    const waitlisted = {
      ...decision,
      status: 'WAITLISTED',
      allowedActions: [],
      actionableQuantity: 0,
      revokedQuantity: 3,
      actionableLines: [
        { productId: ID, grantedQuantity: 3, revokedQuantity: 3, actionableQuantity: 0 },
      ],
      revocations: [
        {
          allocationLineId: ID,
          productId: ID,
          quantity: 3,
          kind: 'WAITLISTED',
          waitTicketId: null,
          waitTicketCode: null,
          actorName: 'HTKD A',
          actorRole: 'HTKD',
          createdAt: '2026-10-05T03:00:00.000Z',
        },
      ],
      requeued: [
        {
          waitTicketId: ID,
          waitTicketCode: 'PC-0000001',
          productId: ID,
          quantity: 3,
          mode: 'ADD_DEMAND',
          createdTicket: true,
        },
      ],
    };
    expect(AllocationDecisionSchema.parse(waitlisted).status).toBe('WAITLISTED');
    expect(
      AllocationDecisionSchema.safeParse({ ...waitlisted, allowedActions: ['REJECT'] }).success,
    ).toBe(false);
    expect(
      ListAllocationDecisionsQuerySchema.parse({ includeWaitlist: 'true' }).includeWaitlist,
    ).toBe(true);
  });

  it('pages and filters decisions on the server', () => {
    expect(ListAllocationDecisionsQuerySchema.parse({ status: 'PENDING' })).toEqual({
      page: 1,
      pageSize: 20,
      status: 'PENDING',
    });
    expect(ListAllocationDecisionsQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
    expect(ListAllocationDecisionsQuerySchema.safeParse({ storeIds: ID }).success).toBe(false);
  });

  it('adds the decision to session documents only on request, keeping the old shape valid', () => {
    expect(ListSessionDocumentsQuerySchema.parse({ includeDecision: 'true' })).toMatchObject({
      includeDecision: true,
    });
    expect(ListSessionDocumentsQuerySchema.parse({})).not.toHaveProperty('includeDecision');
    const document = {
      id: 'x',
      orderCode: 'TH',
      resultCode: 'KQ',
      sessionId: ID,
      storeId: ID,
      allocationRunId: ID,
      version: 1,
      createdAt: '2026-10-05T02:00:00.000Z',
      hasPrioritySource: false,
      carriedAllocations: [],
      sources: [],
      lines: [],
    };
    expect(SessionDocumentSchema.safeParse(document).success).toBe(true);
    expect(SessionDocumentSchema.safeParse({ ...document, decision }).success).toBe(true);
    expect(SessionDocumentSchema.safeParse({ ...document, decision: null }).success).toBe(true);
  });
});
