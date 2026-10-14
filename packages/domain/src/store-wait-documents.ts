/**
 * Pure rules of the store wait document ("phiếu chờ tổng", docs/store-active-wait-document.md).
 *
 * A store has at most one current document that lists, per product, the demand still open for
 * it: bags waiting to be allocated (the active wait tickets' remaining quantity) plus bags already
 * granted from those tickets that still wait for the store's answer (holds of PENDING results).
 * The wait tickets stay the operational lines the allocation run reads; the document is the
 * auditable store-level record built over them.
 *
 * A business event that changes the open quantity of any product closes the current document and
 * opens its successor: carried bags keep their history, new demand is shown as added, and what
 * the event resolved is recorded on the closed document by category. An event that changes
 * nothing (a replay, a page refresh, an allocation moving bags from waiting to awaiting the answer)
 * plans nothing, which is what makes reconciling idempotent.
 */

export type StoreWaitReductionCategory = 'confirmed' | 'cancelled' | 'adjusted';

export type StoreWaitDocumentClosure = 'merged' | 'rolled_over' | 'completed' | 'cancelled';

/** Live open demand of one product of the store, as read from the wait tickets and holds. */
export interface StoreWaitLiveLine {
  readonly productId: string;
  readonly remainingQuantity: number;
  readonly pendingQuantity: number;
}

/** A product line of the current document: what was open when it was opened. */
export interface StoreWaitCurrentLine {
  readonly productId: string;
  readonly openQuantity: number;
}

/** What the event itself resolved, as declared by the command that caused it. */
export interface StoreWaitDeclaredReduction {
  readonly productId: string;
  readonly category: StoreWaitReductionCategory;
  readonly quantity: number;
}

export interface StoreWaitReconciliationInput {
  /** Lines of the current document, or null when the store has none. */
  readonly current: readonly StoreWaitCurrentLine[] | null;
  readonly live: readonly StoreWaitLiveLine[];
  readonly declared: readonly StoreWaitDeclaredReduction[];
  /**
   * Category of a drop the event did not declare (a cancelled source skipped while moving a
   * result back to waiting, a corrected receipt shortage, a system catch-up after a deployment).
   */
  readonly undeclaredCategory: StoreWaitReductionCategory;
}

export interface StoreWaitClosingLine {
  readonly productId: string;
  readonly openQuantity: number;
  readonly confirmedQuantity: number;
  readonly cancelledQuantity: number;
  readonly adjustedQuantity: number;
  readonly carriedOutQuantity: number;
}

export interface StoreWaitOpeningLine {
  readonly productId: string;
  readonly carriedInQuantity: number;
  readonly addedQuantity: number;
  readonly remainingQuantity: number;
  readonly pendingQuantity: number;
}

export type StoreWaitReconciliationPlan =
  | { readonly kind: 'NOOP' }
  | { readonly kind: 'OPEN'; readonly opening: readonly StoreWaitOpeningLine[] }
  | {
      readonly kind: 'CLOSE';
      readonly closure: 'completed' | 'cancelled';
      readonly closing: readonly StoreWaitClosingLine[];
      /** Declared bags that exceeded what the document had open (out-of-sync evidence). */
      readonly overDeclared: readonly StoreWaitDeclaredReduction[];
      readonly undeclared: readonly StoreWaitDeclaredReduction[];
    }
  | {
      readonly kind: 'ROLLOVER';
      readonly closure: 'merged' | 'rolled_over';
      readonly closing: readonly StoreWaitClosingLine[];
      readonly opening: readonly StoreWaitOpeningLine[];
      readonly overDeclared: readonly StoreWaitDeclaredReduction[];
      readonly undeclared: readonly StoreWaitDeclaredReduction[];
    };

const CATEGORY_ORDER: readonly StoreWaitReductionCategory[] = [
  'confirmed',
  'cancelled',
  'adjusted',
];

function assertQuantity(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative whole number of bags.`);
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Decides what the store's document becomes after an event.
 *
 * Per product, with `open` the quantity of the current document and `next` the live quantity:
 * the declared reductions (clamped to `open`) are what the event resolved; the rest of `open`
 * is carried; if `next` is smaller than the carry, the difference is an undeclared reduction of
 * `undeclaredCategory`; whatever `next` holds beyond the carry is new demand. So every closed
 * line conserves `open = confirmed + cancelled + adjusted + carriedOut` and every opened line
 * `carriedIn + added = remaining + pending`, and carriedOut of a product equals the carriedIn of
 * the same product on the successor.
 */
export function planStoreWaitReconciliation(
  input: StoreWaitReconciliationInput,
): StoreWaitReconciliationPlan {
  const openByProduct = new Map<string, number>();
  for (const line of input.current ?? []) {
    assertQuantity(line.openQuantity, 'An open document quantity');
    if (line.openQuantity === 0) throw new RangeError('A document line is never opened empty.');
    if (openByProduct.has(line.productId)) {
      throw new RangeError('A document has one line per product.');
    }
    openByProduct.set(line.productId, line.openQuantity);
  }
  const liveByProduct = new Map<string, StoreWaitLiveLine>();
  for (const line of input.live) {
    assertQuantity(line.remainingQuantity, 'A remaining quantity');
    assertQuantity(line.pendingQuantity, 'A pending quantity');
    if (line.remainingQuantity + line.pendingQuantity === 0) continue;
    if (liveByProduct.has(line.productId)) {
      throw new RangeError('Live demand has one line per product.');
    }
    liveByProduct.set(line.productId, line);
  }
  const declaredByProduct = new Map<string, Map<StoreWaitReductionCategory, number>>();
  for (const reduction of input.declared) {
    assertQuantity(reduction.quantity, 'A declared reduction');
    if (reduction.quantity === 0) continue;
    const byCategory = declaredByProduct.get(reduction.productId) ?? new Map();
    byCategory.set(
      reduction.category,
      (byCategory.get(reduction.category) ?? 0) + reduction.quantity,
    );
    declaredByProduct.set(reduction.productId, byCategory);
  }

  if (input.current === null) {
    if (liveByProduct.size === 0) return { kind: 'NOOP' };
    return {
      kind: 'OPEN',
      opening: sortedUnique(liveByProduct.keys()).map((productId) => {
        const live = liveByProduct.get(productId)!;
        return {
          productId,
          carriedInQuantity: 0,
          addedQuantity: live.remainingQuantity + live.pendingQuantity,
          remainingQuantity: live.remainingQuantity,
          pendingQuantity: live.pendingQuantity,
        };
      }),
    };
  }

  const unchanged =
    declaredByProduct.size === 0 &&
    openByProduct.size === liveByProduct.size &&
    [...openByProduct].every(([productId, open]) => {
      const live = liveByProduct.get(productId);
      return live !== undefined && live.remainingQuantity + live.pendingQuantity === open;
    });
  if (unchanged) return { kind: 'NOOP' };

  const closing: StoreWaitClosingLine[] = [];
  const carriedByProduct = new Map<string, number>();
  const overDeclared: StoreWaitDeclaredReduction[] = [];
  const undeclared: StoreWaitDeclaredReduction[] = [];
  for (const productId of sortedUnique(openByProduct.keys())) {
    const open = openByProduct.get(productId)!;
    const live = liveByProduct.get(productId);
    const next = live ? live.remainingQuantity + live.pendingQuantity : 0;
    const resolved = new Map<StoreWaitReductionCategory, number>();
    let left = open;
    for (const category of CATEGORY_ORDER) {
      const declared = declaredByProduct.get(productId)?.get(category) ?? 0;
      const taken = Math.min(declared, left);
      left -= taken;
      if (taken > 0) resolved.set(category, taken);
      if (declared > taken) {
        overDeclared.push({ productId, category, quantity: declared - taken });
      }
    }
    let carried = left;
    if (next < carried) {
      const drop = carried - next;
      carried = next;
      resolved.set(input.undeclaredCategory, (resolved.get(input.undeclaredCategory) ?? 0) + drop);
      undeclared.push({ productId, category: input.undeclaredCategory, quantity: drop });
    }
    carriedByProduct.set(productId, carried);
    closing.push({
      productId,
      openQuantity: open,
      confirmedQuantity: resolved.get('confirmed') ?? 0,
      cancelledQuantity: resolved.get('cancelled') ?? 0,
      adjustedQuantity: resolved.get('adjusted') ?? 0,
      carriedOutQuantity: carried,
    });
  }
  for (const [productId, byCategory] of declaredByProduct) {
    if (openByProduct.has(productId)) continue;
    for (const [category, quantity] of byCategory) {
      overDeclared.push({ productId, category, quantity });
    }
  }

  const opening: StoreWaitOpeningLine[] = sortedUnique(liveByProduct.keys()).map((productId) => {
    const live = liveByProduct.get(productId)!;
    const total = live.remainingQuantity + live.pendingQuantity;
    const carriedIn = carriedByProduct.get(productId) ?? 0;
    return {
      productId,
      carriedInQuantity: carriedIn,
      addedQuantity: total - carriedIn,
      remainingQuantity: live.remainingQuantity,
      pendingQuantity: live.pendingQuantity,
    };
  });

  if (opening.length === 0) {
    const cancelled = closing.reduce((sum, line) => sum + line.cancelledQuantity, 0);
    const other = closing.reduce(
      (sum, line) => sum + line.confirmedQuantity + line.adjustedQuantity,
      0,
    );
    return {
      kind: 'CLOSE',
      closure: cancelled > 0 && other === 0 ? 'cancelled' : 'completed',
      closing,
      overDeclared,
      undeclared,
    };
  }
  const added = opening.reduce((sum, line) => sum + line.addedQuantity, 0);
  return {
    kind: 'ROLLOVER',
    closure: added > 0 ? 'merged' : 'rolled_over',
    closing,
    opening,
    overDeclared,
    undeclared,
  };
}

export type StoreWaitDocumentStatus = 'current' | StoreWaitDocumentClosure;

/** Vietnamese label of a document, naming the successor when it has one. */
export function storeWaitDocumentLabel(
  status: StoreWaitDocumentStatus,
  successorCode: string | null,
): string {
  switch (status) {
    case 'current':
      return 'Đang hoạt động';
    case 'merged':
      return `Đã xử lý · Gộp vào phiếu ${successorCode ?? '?'}`;
    case 'rolled_over':
      return `Đã xử lý · Chuyển phần còn lại sang phiếu ${successorCode ?? '?'}`;
    case 'completed':
      return 'Đã xử lý xong';
    case 'cancelled':
      return 'Đã hủy';
  }
}
