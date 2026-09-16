export { closeDatabase, createDatabase, db, pool } from './client.js';
export type { Database, DatabaseClient } from './client.js';

export {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  withIdempotency,
} from './idempotency.js';
export type {
  IdempotencyInput,
  IdempotencyResult,
  IdempotentOperationResult,
} from './idempotency.js';

export {
  createOrderRequest,
  OrderRequestAuthorizationError,
  OrderSessionUnavailableError,
  RequestLimitExceededError,
  submitOrderRequest,
} from './order-requests.js';
export type {
  CreatedOrderRequest,
  CreateOrderRequestInput,
  CreateOrderRequestItemInput,
  SubmitOrderRequestInput,
} from './order-requests.js';

export * from './schema.js';
export { PRODUCT_SEEDS, STORE_GROUP_SEEDS, STORE_SEEDS } from './seed-data.js';
export type { ProductSeed, StoreGroupSeed, StoreSeed } from './seed-data.js';

export { withAdvisoryLock, withSerializableTransaction, withTransaction } from './transaction.js';
export type {
  RetryableTransactionOptions,
  Transaction,
  TransactionOptions,
} from './transaction.js';

export {
  applyWarehouseMovement,
  recordWarehouseMovement,
  WarehouseBalanceViolationError,
  WarehouseMovementConflictError,
} from './warehouse.js';
export type { WarehouseMovementInput, WarehouseMovementResult } from './warehouse.js';
