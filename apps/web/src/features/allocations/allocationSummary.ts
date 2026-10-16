import type {
  AllocationResult,
  SessionWaitDocuments,
  SessionWaitDocumentSnapshot,
} from '@idosi/contracts';

export interface SummaryItem {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
}

export interface WaitDocumentSummary {
  readonly code: string;
  /** Bags still waiting for allocation at that moment: what the store's wait document lists. */
  readonly items: readonly SummaryItem[];
  readonly total: number;
  /**
   * Bags of the document already granted and awaiting the store's answer. They no longer wait
   * for allocation, so they are kept apart from `items` (a grant is never also a waiting bag).
   */
  readonly pendingItems: readonly SummaryItem[];
  readonly pendingTotal: number;
}

export interface WaitDocumentChange {
  /** "Phiếu chờ cũ": the store's wait document just before this run. */
  readonly before: WaitDocumentSummary | null;
  /**
   * "Phiếu chờ mới": the store's wait document right after this run. What still waits is the old
   * document's waiting bags minus what this run granted them, plus this session's waiting bags.
   */
  readonly after: WaitDocumentSummary | null;
  /** False when the run left the store's open demand (and so its document) unchanged. */
  readonly changed: boolean;
  /**
   * True when this session queued bags but no wait document exists: the run predates the store
   * wait documents (0045), so old/new documents cannot be shown honestly.
   */
  readonly untracked: boolean;
}

export interface AllocationSummary {
  /** What the store ordered in this session (ordinary orders, not wait-ticket priority). */
  readonly ordered: readonly SummaryItem[];
  readonly orderedTotal: number;
  /** Everything granted in this session, ordinary orders and wait tickets together. */
  readonly granted: readonly SummaryItem[];
  readonly grantedTotal: number;
  /** The part of `granted` that went to the store's earlier wait tickets (priority). */
  readonly grantedForWait: readonly SummaryItem[];
  /** The part of this session's orders not granted, queued for priority. */
  readonly waiting: readonly SummaryItem[];
  readonly waitingTotal: number;
  readonly carried: readonly SummaryItem[];
  /** Null when the response carried no wait documents (not requested). */
  readonly waitDocuments: WaitDocumentChange | null;
}

/** The parts of a session document the summary reads. */
export interface AllocationSummaryInput {
  readonly sources: readonly {
    readonly waitTicketId: string | null;
    readonly result: Pick<
      AllocationResult,
      'productId' | 'requestedQuantity' | 'allocatedQuantity' | 'waitlistedQuantity'
    >;
  }[];
  readonly carriedAllocations: readonly { readonly productId: string; readonly quantity: number }[];
  readonly waitDocuments?: SessionWaitDocuments | null | undefined;
}

type Totals = Map<string, number>;

function add(totals: Totals, productId: string, quantity: number) {
  totals.set(productId, (totals.get(productId) ?? 0) + quantity);
}

function items(totals: Totals, productName: (productId: string) => string): SummaryItem[] {
  return [...totals]
    .filter(([, quantity]) => quantity > 0)
    .map(([productId, quantity]) => ({ productId, name: productName(productId), quantity }));
}

function total(list: readonly SummaryItem[]): number {
  return list.reduce((sum, item) => sum + item.quantity, 0);
}

function waitDocumentSummary(
  snapshot: SessionWaitDocumentSnapshot | null,
  productName: (productId: string) => string,
): WaitDocumentSummary | null {
  if (!snapshot) return null;
  const waiting: Totals = new Map();
  const pending: Totals = new Map();
  for (const line of snapshot.lines) {
    add(waiting, line.productId, line.remainingQuantity);
    add(pending, line.productId, line.pendingQuantity);
  }
  const waitingItems = items(waiting, productName);
  const pendingItems = items(pending, productName);
  return {
    code: snapshot.code,
    items: waitingItems,
    total: total(waitingItems),
    pendingItems,
    pendingTotal: total(pendingItems),
  };
}

/**
 * What one store ordered in one session, what it got, what still waits, and how its wait
 * document moved. Wait-ticket sources are the store's earlier demand: their grants count in the
 * result, but their remainder is already on the old wait document, so it never counts again as
 * this session's waiting bags.
 */
export function summarizeAllocation(
  document: AllocationSummaryInput,
  productName: (productId: string) => string,
): AllocationSummary {
  const ordered: Totals = new Map();
  const granted: Totals = new Map();
  const grantedForWait: Totals = new Map();
  const waiting: Totals = new Map();
  for (const { result, waitTicketId } of document.sources) {
    add(granted, result.productId, result.allocatedQuantity);
    if (waitTicketId !== null) {
      add(grantedForWait, result.productId, result.allocatedQuantity);
      continue;
    }
    add(ordered, result.productId, result.requestedQuantity);
    add(waiting, result.productId, result.waitlistedQuantity);
  }
  const carried: Totals = new Map();
  for (const line of document.carriedAllocations) add(carried, line.productId, line.quantity);
  const orderedItems = items(ordered, productName);
  const grantedItems = items(granted, productName);
  const waitingItems = items(waiting, productName);
  const waitDocuments = document.waitDocuments ?? null;
  return {
    ordered: orderedItems,
    orderedTotal: total(orderedItems),
    granted: grantedItems,
    grantedTotal: total(grantedItems),
    grantedForWait: items(grantedForWait, productName),
    waiting: waitingItems,
    waitingTotal: total(waitingItems),
    carried: items(carried, productName),
    waitDocuments: waitDocuments && {
      before: waitDocumentSummary(waitDocuments.before, productName),
      after: waitDocumentSummary(waitDocuments.after, productName),
      changed: waitDocuments.changed,
      untracked:
        waitDocuments.before === null && waitDocuments.after === null && total(waitingItems) > 0,
    },
  };
}

/** "2 Nam, 2 Nữ, 2 Đầm" — the wording stores use when they talk about a result. */
export function summaryText(list: readonly SummaryItem[], empty: string): string {
  return list.length === 0 ? empty : list.map((item) => `${item.quantity} ${item.name}`).join(', ');
}
