import { describe, expect, it } from 'vitest';

import {
  effectivePriorityOfferStatus,
  planPriorityOfferResponse,
  PriorityOfferConflictError,
  WaitTicketValidationError,
} from '../src/wait-ticket-operations.js';

const BEFORE_DEADLINE = new Date('2026-09-17T01:59:59.999Z');
const DEADLINE = new Date('2026-09-17T02:00:00.000Z');

describe('priority offer response transition', () => {
  it('reads an overdue offered row as effectively expired', () => {
    expect(
      effectivePriorityOfferStatus(
        { status: 'offered', responseDeadlineAt: DEADLINE },
        new Date(DEADLINE),
      ),
    ).toBe('expired');
    expect(
      effectivePriorityOfferStatus(
        { status: 'offered', responseDeadlineAt: DEADLINE },
        BEFORE_DEADLINE,
      ),
    ).toBe('offered');
  });

  it('accepts the complete offered quantity before the deadline', () => {
    expect(
      planPriorityOfferResponse({
        action: 'accept',
        currentStatus: 'offered',
        offeredQuantity: 2,
        acceptedQuantity: 2,
        responseDeadlineAt: DEADLINE,
        now: BEFORE_DEADLINE,
        waitTicketStatus: 'active',
        waitTicketRemainingQuantity: 3,
      }),
    ).toEqual({ status: 'accepted', acceptedQuantity: 2, effectiveAction: 'accept' });
  });

  it('rejects partial acceptance because the database invariant requires all-or-nothing', () => {
    expect(() =>
      planPriorityOfferResponse({
        action: 'accept',
        currentStatus: 'offered',
        offeredQuantity: 2,
        acceptedQuantity: 1,
        responseDeadlineAt: DEADLINE,
        now: BEFORE_DEADLINE,
        waitTicketStatus: 'active',
        waitTicketRemainingQuantity: 3,
      }),
    ).toThrow(WaitTicketValidationError);
  });

  it('persists timeout instead of accepting at the exact deadline', () => {
    expect(
      planPriorityOfferResponse({
        action: 'accept',
        currentStatus: 'offered',
        offeredQuantity: 2,
        acceptedQuantity: 2,
        responseDeadlineAt: DEADLINE,
        now: new Date(DEADLINE),
        waitTicketStatus: 'active',
        waitTicketRemainingQuantity: 3,
      }),
    ).toEqual({ status: 'expired', acceptedQuantity: 0, effectiveAction: 'expire' });
  });

  it('declines an offer before the deadline without consuming wait demand', () => {
    expect(
      planPriorityOfferResponse({
        action: 'decline',
        currentStatus: 'offered',
        offeredQuantity: 2,
        responseDeadlineAt: DEADLINE,
        now: BEFORE_DEADLINE,
        waitTicketStatus: 'active',
        waitTicketRemainingQuantity: 2,
      }),
    ).toEqual({ status: 'declined', acceptedQuantity: 0, effectiveAction: 'decline' });
  });

  it('does not expire an offer early', () => {
    expect(() =>
      planPriorityOfferResponse({
        action: 'expire',
        currentStatus: 'offered',
        offeredQuantity: 1,
        responseDeadlineAt: DEADLINE,
        now: BEFORE_DEADLINE,
        waitTicketStatus: 'active',
        waitTicketRemainingQuantity: 1,
      }),
    ).toThrow(PriorityOfferConflictError);
  });

  it('cancels a stale open offer when its wait ticket is no longer active', () => {
    expect(
      planPriorityOfferResponse({
        action: 'accept',
        currentStatus: 'offered',
        offeredQuantity: 1,
        acceptedQuantity: 1,
        responseDeadlineAt: DEADLINE,
        now: BEFORE_DEADLINE,
        waitTicketStatus: 'fulfilled',
        waitTicketRemainingQuantity: 0,
      }),
    ).toEqual({ status: 'cancelled', acceptedQuantity: 0, effectiveAction: 'cancel' });
  });

  it('rejects repeat transitions under a different idempotency key', () => {
    expect(() =>
      planPriorityOfferResponse({
        action: 'decline',
        currentStatus: 'accepted',
        offeredQuantity: 1,
        responseDeadlineAt: DEADLINE,
        now: BEFORE_DEADLINE,
        waitTicketStatus: 'active',
        waitTicketRemainingQuantity: 1,
      }),
    ).toThrow(PriorityOfferConflictError);
  });
});
