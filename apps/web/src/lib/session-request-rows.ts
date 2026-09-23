import type {
  OrderSession,
  Store,
  StoreOrderRequest,
  StoreOrderRequestStatus,
} from '@idosi/contracts';

/**
 * One row of the "Phiên nhận đơn và phân bổ" table. Each order request is its own row so
 * the reader sees when it was sent and which store sent it; a session nobody ordered in
 * still gets one row, so its status and results stay reachable.
 */
export interface SessionRequestRow {
  readonly key: string;
  readonly session: OrderSession;
  readonly request: StoreOrderRequest | null;
  /** The first row of its session carries the session-wide admin actions. */
  readonly firstOfSession: boolean;
  readonly store: { readonly code: string; readonly name: string } | null;
}

export const orderRequestStatusCopy: Record<StoreOrderRequestStatus, string> = {
  SUBMITTED: 'Đã gửi',
  MERGED: 'Đã gộp',
  CANCELLED: 'Đã hủy',
};

export function sessionRequestRows(
  sessions: readonly OrderSession[],
  requests: readonly StoreOrderRequest[],
  stores: readonly Pick<Store, 'id' | 'code' | 'name'>[],
): SessionRequestRow[] {
  const storeById = new Map(stores.map((store) => [store.id, store]));
  const requestsBySession = new Map<string, StoreOrderRequest[]>();
  for (const request of requests) {
    const bucket = requestsBySession.get(request.sessionId) ?? [];
    bucket.push(request);
    requestsBySession.set(request.sessionId, bucket);
  }

  return sessions.flatMap((session): SessionRequestRow[] => {
    const sessionRequests = [...(requestsBySession.get(session.id) ?? [])].sort(
      (left, right) =>
        Date.parse(right.submittedAt) - Date.parse(left.submittedAt) ||
        left.id.localeCompare(right.id),
    );
    if (sessionRequests.length === 0) {
      return [{ key: session.id, session, request: null, firstOfSession: true, store: null }];
    }
    return sessionRequests.map((request, index) => {
      const store = storeById.get(request.storeId);
      return {
        key: request.id,
        session,
        request,
        firstOfSession: index === 0,
        store: store ? { code: store.code, name: store.name } : null,
      };
    });
  });
}

const submittedDateFormatter = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Asia/Ho_Chi_Minh',
});
const submittedTimeFormatter = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
});

/** Vietnam wall-clock date and time a request was sent, independent of the browser zone. */
export function formatRequestSubmittedAt(value: string): { date: string; time: string } {
  const instant = new Date(value);
  return {
    date: submittedDateFormatter.format(instant),
    time: submittedTimeFormatter.format(instant),
  };
}
