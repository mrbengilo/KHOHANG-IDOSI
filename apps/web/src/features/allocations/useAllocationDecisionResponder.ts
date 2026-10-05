import type { AllocationDecision, RespondAllocationDecisionRequest } from '@idosi/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { retainIdempotencyForExactRetry, type RetryAttempt } from '../../lib/idempotency-retry';
import {
  allocationDecisionKeys,
  decisionCode,
  isUncertainOutcome,
  respondAllocationDecision,
  respondErrorMessage,
} from './allocationDecisionApi';

export interface DecisionFeedback {
  readonly decisionId: string;
  readonly message: string;
  readonly uncertain?: boolean;
}

/**
 * One answer at a time across every place that shows results. The official state changes only
 * after the server confirms; an uncertain failure keeps the key so a retry cannot double-apply.
 */
export function useAllocationDecisionResponder() {
  const queryClient = useQueryClient();
  const attempt = useRef<RetryAttempt | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<{
    decisionId: string;
    action: RespondAllocationDecisionRequest['action'];
  } | null>(null);
  const [error, setError] = useState<DecisionFeedback | null>(null);
  const [success, setSuccess] = useState<DecisionFeedback | null>(null);

  const refreshDependents = useCallback(
    () =>
      Promise.all(
        [
          allocationDecisionKeys.all,
          ['allocation-results'],
          ['store-receipt-sources'],
          ['held-allocations'],
          ['warehouse-inventory'],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
    [queryClient],
  );

  const respond = useCallback(
    async (decision: AllocationDecision, input: RespondAllocationDecisionRequest) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      const fingerprint = `${decision.id}:${JSON.stringify(input)}`;
      const retry = retainIdempotencyForExactRetry(attempt.current, fingerprint);
      attempt.current = retry;
      setBusy({ decisionId: decision.id, action: input.action });
      setError(null);
      setSuccess(null);
      try {
        const updated = await respondAllocationDecision(decision.id, input, retry.key);
        attempt.current = null;
        setSuccess({
          decisionId: decision.id,
          message:
            updated.status === 'ACCEPTED'
              ? `Đã chấp nhận phiếu ${decisionCode(updated)}. ${
                  updated.shipment?.status === 'DISPATCHED'
                    ? 'Kho đã xuất hàng; cửa hàng khai nhận đủ hoặc thiếu theo thực tế khi hàng đến.'
                    : 'Hàng được giữ tại kho và giao chung với đơn thường kế tiếp.'
                }`
              : `Đã ghi nhận từ chối nhận phiếu ${decisionCode(updated)}; ${updated.releasedQuantity} bao đã trả lại kho.`,
        });
        await refreshDependents();
        return true;
      } catch (cause) {
        const uncertain = isUncertainOutcome(cause);
        // A definite refusal frees the key; the next answer is a new request.
        if (!uncertain) attempt.current = null;
        setError({ decisionId: decision.id, message: respondErrorMessage(cause), uncertain });
        if (!uncertain) await refreshDependents();
        return false;
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
    },
    [refreshDependents],
  );

  return { busy, error, success, respond };
}
