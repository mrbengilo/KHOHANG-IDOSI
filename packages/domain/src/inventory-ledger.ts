import { DomainError, invariant } from './errors.js';
import {
  isoTimestamp,
  nonEmpty,
  nonNegativeInteger,
  nonZeroInteger,
  safeIntegerSum,
  type IsoTimestamp,
} from './validation.js';

export const INVENTORY_LEDGER_ENTRY_TYPES = [
  'RECEIPT',
  'ALLOCATION_HOLD',
  'HOLD_RELEASE',
  'SHIPMENT',
  'RETURN',
  'ADJUSTMENT',
] as const;
export type InventoryLedgerEntryType = (typeof INVENTORY_LEDGER_ENTRY_TYPES)[number];

export interface InventoryLedgerEntry {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly type: InventoryLedgerEntryType;
  readonly referenceId: string;
  readonly quantityDelta: number;
  readonly balanceAfter: number;
  readonly occurredAt: IsoTimestamp;
  readonly reason: string;
}

export interface InventoryLedger {
  readonly id: string;
  readonly locationId: string;
  readonly productId: string;
  readonly openingBalance: number;
  readonly openedAt: IsoTimestamp;
  readonly entries: readonly InventoryLedgerEntry[];
}

export interface InventoryLedgerInput {
  readonly id: string;
  readonly locationId: string;
  readonly productId: string;
  readonly openingBalance: number;
  readonly openedAt: string;
}

export function createInventoryLedger(input: InventoryLedgerInput): InventoryLedger {
  return Object.freeze({
    id: nonEmpty(input.id, 'ledgerId'),
    locationId: nonEmpty(input.locationId, 'locationId'),
    productId: nonEmpty(input.productId, 'productId'),
    openingBalance: nonNegativeInteger(input.openingBalance, 'openingBalance'),
    openedAt: isoTimestamp(input.openedAt, 'openedAt'),
    entries: Object.freeze([]),
  });
}

export interface AppendInventoryLedgerEntryInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly type: InventoryLedgerEntryType;
  readonly referenceId: string;
  readonly quantityDelta: number;
  readonly occurredAt: string;
  readonly reason: string;
}

function currentLedgerBalance(ledger: InventoryLedger): number {
  return ledger.entries.at(-1)?.balanceAfter ?? ledger.openingBalance;
}

function sameLedgerCommand(
  entry: InventoryLedgerEntry,
  input: AppendInventoryLedgerEntryInput,
): boolean {
  return (
    entry.type === input.type &&
    entry.referenceId === input.referenceId &&
    entry.quantityDelta === input.quantityDelta &&
    entry.reason === input.reason
  );
}

export interface AppendInventoryLedgerEntryResult {
  readonly ledger: InventoryLedger;
  readonly entry: InventoryLedgerEntry;
  readonly replayed: boolean;
}

export function appendInventoryLedgerEntry(
  ledger: InventoryLedger,
  input: AppendInventoryLedgerEntryInput,
): AppendInventoryLedgerEntryResult {
  assertInventoryLedgerValid(ledger);
  invariant(
    INVENTORY_LEDGER_ENTRY_TYPES.includes(input.type),
    'INVALID_ARGUMENT',
    'Unknown inventory ledger entry type',
    { type: input.type },
  );
  const idempotencyKey = nonEmpty(input.idempotencyKey, 'idempotencyKey');
  const replay = ledger.entries.find((entry) => entry.idempotencyKey === idempotencyKey);
  if (replay !== undefined) {
    if (!sameLedgerCommand(replay, input)) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'The ledger idempotency key was already used with another payload',
        { idempotencyKey },
      );
    }
    return Object.freeze({ ledger, entry: replay, replayed: true });
  }

  invariant(
    !ledger.entries.some((entry) => entry.id === input.id),
    'INVALID_ARGUMENT',
    'Inventory ledger entry id must be unique',
    { ledgerEntryId: input.id },
  );
  const quantityDelta = nonZeroInteger(input.quantityDelta, 'quantityDelta');
  const balanceAfter = safeIntegerSum(
    currentLedgerBalance(ledger),
    quantityDelta,
    'inventory balance',
  );
  invariant(
    balanceAfter >= 0,
    'INSUFFICIENT_INVENTORY',
    'Inventory ledger entry would make the balance negative',
    { ledgerId: ledger.id, balanceAfter },
  );
  const entry: InventoryLedgerEntry = Object.freeze({
    id: nonEmpty(input.id, 'ledgerEntryId'),
    idempotencyKey,
    type: input.type,
    referenceId: nonEmpty(input.referenceId, 'referenceId'),
    quantityDelta,
    balanceAfter,
    occurredAt: isoTimestamp(input.occurredAt, 'occurredAt'),
    reason: nonEmpty(input.reason, 'reason'),
  });
  const updated: InventoryLedger = Object.freeze({
    ...ledger,
    entries: Object.freeze([...ledger.entries, entry]),
  });
  return Object.freeze({ ledger: updated, entry, replayed: false });
}

export interface InventoryLedgerReconciliation {
  readonly ledgerId: string;
  readonly calculatedBalance: number;
  readonly recordedBalance: number;
  readonly observedBalance: number | null;
  readonly variance: number | null;
  readonly balanced: boolean;
}

export function reconcileInventoryLedger(
  ledger: InventoryLedger,
  observedBalance: number | null = null,
): InventoryLedgerReconciliation {
  let calculatedBalance = ledger.openingBalance;
  for (const entry of ledger.entries) {
    calculatedBalance = safeIntegerSum(
      calculatedBalance,
      entry.quantityDelta,
      'calculated ledger balance',
    );
    invariant(
      calculatedBalance >= 0,
      'LEDGER_CORRUPTED',
      'Inventory ledger history makes the balance negative',
      { ledgerId: ledger.id, entryId: entry.id, calculatedBalance },
    );
    invariant(
      calculatedBalance === entry.balanceAfter,
      'LEDGER_CORRUPTED',
      'Inventory ledger balanceAfter does not match entry replay',
      { ledgerId: ledger.id, entryId: entry.id },
    );
  }
  const recordedBalance = currentLedgerBalance(ledger);
  const normalizedObserved =
    observedBalance === null ? null : nonNegativeInteger(observedBalance, 'observedBalance');
  const variance = normalizedObserved === null ? null : normalizedObserved - calculatedBalance;
  return Object.freeze({
    ledgerId: ledger.id,
    calculatedBalance,
    recordedBalance,
    observedBalance: normalizedObserved,
    variance,
    balanced: calculatedBalance === recordedBalance && (variance === null || variance === 0),
  });
}

export function assertInventoryLedgerValid(ledger: InventoryLedger): void {
  nonEmpty(ledger.id, 'ledgerId');
  nonEmpty(ledger.locationId, 'locationId');
  nonEmpty(ledger.productId, 'productId');
  nonNegativeInteger(ledger.openingBalance, 'openingBalance');
  reconcileInventoryLedger(ledger);
  invariant(
    new Set(ledger.entries.map((entry) => entry.id)).size === ledger.entries.length,
    'LEDGER_CORRUPTED',
    'Inventory ledger entry ids must be unique',
    { ledgerId: ledger.id },
  );
  invariant(
    new Set(ledger.entries.map((entry) => entry.idempotencyKey)).size === ledger.entries.length,
    'LEDGER_CORRUPTED',
    'Inventory ledger idempotency keys must be unique',
    { ledgerId: ledger.id },
  );
}

export function inventoryLedgerBalance(ledger: InventoryLedger): number {
  assertInventoryLedgerValid(ledger);
  return currentLedgerBalance(ledger);
}
