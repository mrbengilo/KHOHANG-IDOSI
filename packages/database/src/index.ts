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
  kilogramsToGramsForReport,
  loadMonthlyOperationalReport,
  mergeScopedInboundRows,
  monthWindowInHoChiMinh,
  summarizeMonthlyReport,
  vndPerKilogram,
} from './monthly-report.js';
export type {
  MonthWindow,
  MonthlyInboundHeaderRow,
  MonthlyInboundProductRow,
  MonthlyOperationalReport,
  MonthlyProductOperationalReport,
  MonthlyReportInput,
  MonthlyReportRows,
  MonthlyReportScope,
  MonthlySaleRow,
  ReportMetric,
  ReportMetricSource,
  ReportUnavailableReason,
} from './monthly-report.js';

export {
  ActiveWaitTicketExistsError,
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

export {
  calculateWeightedCostVnd,
  finalizeStoreReceipt,
  finalizeStoreReceiptInTransaction,
  gramsToKilogramsExact,
  kilogramsToGramsExact,
  planWaitShortageMerge,
  reviewStoreOutbound,
  reviewStoreOutboundInTransaction,
  StoreOperationConflictError,
  StoreOperationValidationError,
} from './store-operations.js';
export type {
  FinalizedStoreReceipt,
  FinalizeStoreReceiptInput,
  FinalizeStoreReceiptLineInput,
  ReviewedStoreOutbound,
  ReviewStoreOutboundInput,
  WaitQuantityState,
  WaitShortageMergePlan,
} from './store-operations.js';

export {
  declareStoreReceipt,
  declareStoreReceiptInTransaction,
  returnStoreReceiptForCorrection,
  returnStoreReceiptForCorrectionInTransaction,
  StoreReceiptAuthorizationError,
  submitStoreReceipt,
  submitStoreReceiptInTransaction,
  validateStoreReceiptDeclaration,
} from './store-receipt-workflow.js';
export type {
  DeclareStoreReceiptInput,
  DeclareStoreReceiptLineInput,
  DispatchedStoreReceiptLine,
  ReturnStoreReceiptForCorrectionInput,
  StoreReceiptWorkflowResult,
  SubmitStoreReceiptInput,
} from './store-receipt-workflow.js';

export * from './schema.js';
export {
  PRODUCT_CONVERSION_SEEDS,
  PRODUCT_SEEDS,
  STORE_GROUP_SEEDS,
  STORE_SEEDS,
} from './seed-data.js';
export type { ProductConversionSeed, ProductSeed, StoreGroupSeed, StoreSeed } from './seed-data.js';

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

export {
  cancelWaitTicket,
  cancelWaitTicketInTransaction,
  effectivePriorityOfferStatus,
  getWaitTicketHistory,
  listPriorityOffers,
  listWaitTickets,
  planPriorityOfferResponse,
  PriorityOfferConflictError,
  PriorityOfferNotFoundError,
  respondPriorityOffer,
  respondPriorityOfferInTransaction,
  WaitTicketAuthorizationError,
  WaitTicketConflictError,
  WaitTicketNotFoundError,
  WaitTicketValidationError,
} from './wait-ticket-operations.js';
export type {
  CancelledWaitTicket,
  CancelWaitTicketInput,
  PageInput as WaitTicketPageInput,
  PageMetadata as WaitTicketPageMetadata,
  PriorityOfferDatabaseStatus,
  PriorityOfferEffectiveAction,
  PriorityOfferListInput,
  PriorityOfferPage,
  PriorityOfferRecord,
  PriorityOfferResponseAction,
  PriorityOfferTransition,
  PriorityOfferTransitionInput,
  RespondedPriorityOffer,
  RespondPriorityOfferInput,
  WaitTicketAuditRecord,
  WaitTicketDatabaseStatus,
  WaitTicketHistory,
  WaitTicketHistoryInput,
  WaitTicketListInput,
  WaitTicketPage,
  WaitTicketPriority,
  WaitTicketRecord,
} from './wait-ticket-operations.js';
