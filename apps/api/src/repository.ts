import type {
  CancelledStoreWaitDocument,
  CancelStoreWaitDocumentRequest,
  ListStoreWaitDocumentsQuery,
  ListStoreWaitDocumentsResponse,
  StoreWaitDocumentCancelPreview,
  StoreWaitDocumentDetail,
} from '@idosi/contracts';
import type { InboundStatistics, InboundStatisticsQuery } from '@idosi/contracts';
import type { ReceiptSummary } from '@idosi/contracts';
import type { ListSessionDocumentsQuery, SessionDocument } from '@idosi/contracts';
import type {
  UpdateReshareOrderStatusRequest,
  ReshareOrderStatusUpdate,
  AddSupplierSourceProductsRequest,
  CancelSupplierOrderRequest,
  ConfirmSupplierObservationRequest,
  CreateSupplierSourceRequest,
  ListSupplierOrdersQuery,
  RecordSupplierOrderRequest,
  RecordSupplierSourceReturnRequest,
  SupplierBatch,
  SupplierCommitmentsQuery,
  SupplierCommitmentsResponse,
  SupplierObservation,
  SupplierObservationHistoryQuery,
  SupplierObservationHistoryRow,
  SupplierObservationPreview,
  SupplierObservationRequest,
  SupplierReconciliationQuery,
  SupplierReconciliationResponse,
  SupplierSource,
  AllocationDecision,
  AllocationDecisionDetail,
  ListReshareOrdersQuery,
  ListReshareOrdersResponse,
  ListReshareStoresResponse,
  ReshareStatusHistoryQuery,
  ReshareStatusHistoryResponse,
  ListAllocationDecisionsQuery,
  RespondAllocationDecisionRequest,
} from '@idosi/contracts';
import type { ListStoreBagOpeningsQuery, StoreBagOpening } from '@idosi/contracts';
import type {
  CreateReceiptAdjustmentRequest,
  CreateReceiptReturnRequest,
  ListReceiptAdjustmentsQuery,
  ListReceiptReturnsQuery,
  ReceiptAdjustment,
  ReceiptAdjustmentActionRequest,
  ReceiptAdjustmentContext,
  ReceiptAdjustmentHistoryEvent,
  ReceiptAdjustmentHistoryQuery,
  ReceiptAdjustmentListItem,
  ReceiptReturn,
  ReceiptReturnActionRequest,
  WarehouseInventoryQuery,
  WarehouseInventoryResponse,
  CreateWarehouseStockAdjustmentRequest,
  ListOrderHistoryQuery,
  ListWarehouseStockAdjustmentsQuery,
  OrderHistoryEntry,
  WarehouseStockAdjustment,
  WorkerStatus,
  IdosiProductLink,
  IdosiProductMatching,
  SetIdosiProductLinkRequest,
  SetIdosiStoreCodeRequest,
  StoreNormalSalePending,
  OrderingContext,
  Account,
  AdminAuditLog,
  AllocationResult,
  AuthenticatedPrincipal,
  CancelInboundReceiptRequest,
  CancelStoreOrderRequest,
  CancelWaitTicketRequest,
  CreateOrderSessionRequest,
  CreateProductConversionRequest,
  CreateProductRequest,
  CreateStoreOrderRequest,
  CreateStorePartnerInboundRequest,
  CreateStoreGroupRequest,
  CreateStoreRequest,
  CreateAccountRequest,
  CreateInboundReceiptRequest,
  DeclareStoreReceiptRequest,
  DispatchWarehouseOutboundRequest,
  FinalizeReceiptRequest,
  ConfirmReceiptCostsRequest,
  ListOrderSessionsQuery,
  ListAccountsQuery,
  ListAllocationsQuery,
  ListAuditLogsQuery,
  ListInboundReceiptsQuery,
  ListProductsQuery,
  ListReceiptsQuery,
  ListStorePartnerInboundsQuery,
  ListStoreInventoryBagLedgerQuery,
  ListStoreInventoryBagsQuery,
  ListStoreOutboundsQuery,
  ListHeldAllocationsQuery,
  ListStoreReceiptSourcesQuery,
  ListPriorityOffersQuery,
  ListProductConversionsQuery,
  ListStoreOrderRequestsQuery,
  ListStoreGroupsQuery,
  ListStoresQuery,
  PaginationMeta,
  OrderSession,
  Product,
  ProductConversion,
  PriorityOffer,
  Receipt,
  RespondPriorityOfferRequest,
  ReturnReceiptForCorrectionRequest,
  ResetPasswordRequest,
  ReplaceHtkdAssignmentsRequest,
  Session,
  Store,
  StoreGroup,
  StoreInventoryBag,
  StoreInventoryBagLedgerEntry,
  StoreOrderRequest,
  StoreOutbound,
  StoreSortedStock,
  StoreSortingHistoryEntry,
  StoreSortingResult,
  ListStoreSortingHistoryQuery,
  HeldAllocation,
  StoreReceiptSource,
  StorePartnerInbound,
  SubmitStoreReceiptRequest,
  TransitionOrderSessionRequest,
  UpdateProductRequest,
  UpdateAccountRequest,
  UpdateProductConversionRequest,
  DeleteProductConversionRequest,
  ListWaitTicketsQuery,
  ListWarehouseOutboundRequestsQuery,
  MonthlyOperationalReport,
  MonthlyOperationalReportQuery,
  IdosiOrderStatisticsPayload,
  IdosiStatisticsAttempt,
  IdosiStatisticsScope,
  IdosiStatisticsSnapshot,
  HtkdAssignment,
  InboundReceipt,
  OperationalSettingsVersion,
  WaitTicket,
  WaitTicketCancelPreview,
  WaitTicketHistory,
  WarehouseOutboundRequest,
  OpenStoreInventoryBagRequest,
  CreateStoreOutboundRequest,
  CreateStoreSortingRequest,
  MoveCharityToSaleRequest,
  ExportCharityRequest,
  MoveProductCharityToSaleRequest,
  ProductCharityBalance,
  CreateCharityExportRequest,
  CharityExport,
  MoveProductCancelToSaleRequest,
  FinalizeProductCancelRequest,
  MoveProductSaleToCharityRequest,
  MoveProductSaleToCancelRequest,
  ProductCancelBalance,
  SaleBreakdown,
  ReviewStoreOutboundRequest,
  StoreTransfer,
  SortedSaleTransfer,
  CreateSortedSaleTransferRequest,
  ReceiveSortedSaleTransferRequest,
  ListWarehouseShortageChecksQuery,
  ResolveWarehouseShortageCheckRequest,
  WarehouseShortageCheck,
  CancelSortedSaleTransferRequest,
  ListStoreTransfersQuery,
  CreateStoreTransferRequest,
  DispatchStoreTransferRequest,
  ReceiveStoreTransferRequest,
  CancelStoreTransferRequest,
  WarehouseBalancesResponse,
  UpdateOperationalSettingsRequest,
  UpdateStoreGroupRequest,
  UpdateStoreRequest,
} from '@idosi/contracts';

import { forbidden } from './errors.js';

export interface RequestContext {
  readonly requestId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface AccountCredentials {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: AuthenticatedPrincipal['role'];
  readonly status: 'ACTIVE' | 'LOCKED' | 'DISABLED';
  readonly storeId: string | null;
  readonly passwordHash: string;
  readonly sessionVersion: number;
  readonly assignedStoreIds: readonly string[];
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly pagination: PaginationMeta;
}

export interface CreatedSession {
  readonly token: string;
  readonly session: Session;
}

export interface SubmittedOrderRequest {
  readonly data: StoreOrderRequest;
  readonly replayed: boolean;
}

export interface IdempotentResource<T> {
  readonly data: T;
  readonly replayed: boolean;
}

export interface OrderStatistics {
  readonly storeCode: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly totals: {
    readonly revenueByType: {
      readonly NORMAL: number;
      readonly SALE_KG: number;
      readonly SALE_PIECE: number;
    };
    readonly revenue: number;
    readonly weight: {
      readonly actualKg: string;
      readonly estimatedKg: string;
      readonly totalKg: string;
      readonly isComplete: boolean;
    };
  };
  readonly products: readonly {
    readonly productId: string;
    readonly sku: string;
    readonly name: string;
    readonly revenueVnd: number;
    readonly weightKg: string;
  }[];
  readonly generatedAt: string;
}

/**
 * Roles that read the central warehouse stock table. Only ADMIN manages it; the others see the
 * same per-product aggregate (no per-store reservations, no costs) read-only.
 */
export const WAREHOUSE_INVENTORY_READ_ROLES: readonly AuthenticatedPrincipal['role'][] = [
  'ADMIN',
  'HTKD',
  'STORE',
  'WHOLESALE',
];

export const RETAIL_STORE_OPERATION_FORBIDDEN_MESSAGE =
  'Nghiệp vụ này chỉ dành cho cửa hàng bán lẻ đang hoạt động';

export interface StoreOperationEligibility {
  readonly kind: Store['kind'];
  readonly status: Store['status'];
}

/**
 * Keeps the public API response identical across repository implementations.
 * Callers must load the current store row instead of trusting session claims.
 */
export function assertActiveRetailStore(
  store: StoreOperationEligibility | null,
): asserts store is StoreOperationEligibility & { kind: 'RETAIL'; status: 'ACTIVE' } {
  if (store?.kind !== 'RETAIL' || store.status !== 'ACTIVE') {
    throw forbidden(RETAIL_STORE_OPERATION_FORBIDDEN_MESSAGE);
  }
}

export interface OperationalSettingsState {
  readonly current: OperationalSettingsVersion;
  readonly history: readonly OperationalSettingsVersion[];
}

export interface HtkdAssignmentsState {
  readonly htkdAccountId: string;
  readonly sessionVersion: number;
  readonly assignments: readonly HtkdAssignment[];
}

export interface IdosiStatisticsTarget {
  readonly storeId: string;
  readonly storeCode: string;
  readonly storeName: string;
  readonly idosiStoreCode?: string | null;
}

export interface IdosiStoreCodeRecord {
  readonly storeId: string;
  readonly storeCode: string;
  readonly storeName: string;
  readonly idosiStoreCode: string | null;
}

export interface PersistedIdosiStatisticsState {
  readonly snapshot: IdosiStatisticsSnapshot | null;
  readonly latestAttempt: IdosiStatisticsAttempt | null;
}

export interface SessionActivity {
  readonly active: boolean;
  readonly lastSeenAt: Date;
}

/**
 * Reshare supplier reconciliation (docs/supplier-stock-reconciliation.md). Admin and every active
 * HTKD manage the whole module for all stores (observation, sources, B orders, source returns);
 * store and wholesale reads of commitments and orders are scoped to their own stores.
 */
export interface SupplierReconciliationRepository {
  listSupplierSources(actor: AuthenticatedPrincipal): Promise<SupplierSource[]>;
  createSupplierSource(
    actor: AuthenticatedPrincipal,
    input: CreateSupplierSourceRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<{ id: string }>>;
  addSupplierSourceProducts(
    actor: AuthenticatedPrincipal,
    sourceId: string,
    input: AddSupplierSourceProductsRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<{ added: string[] }>>;
  getSupplierReconciliation(
    actor: AuthenticatedPrincipal,
    query: SupplierReconciliationQuery,
  ): Promise<SupplierReconciliationResponse>;
  previewSupplierObservation(
    actor: AuthenticatedPrincipal,
    input: SupplierObservationRequest,
  ): Promise<SupplierObservationPreview>;
  confirmSupplierObservation(
    actor: AuthenticatedPrincipal,
    input: ConfirmSupplierObservationRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<SupplierObservation>>;
  listSupplierObservationHistory(
    actor: AuthenticatedPrincipal,
    query: SupplierObservationHistoryQuery,
  ): Promise<Page<SupplierObservationHistoryRow>>;
  listSupplierCommitments(
    actor: AuthenticatedPrincipal,
    query: SupplierCommitmentsQuery,
  ): Promise<SupplierCommitmentsResponse>;
  listSupplierOrders(
    actor: AuthenticatedPrincipal,
    query: ListSupplierOrdersQuery,
  ): Promise<Page<SupplierBatch>>;
  recordSupplierOrder(
    actor: AuthenticatedPrincipal,
    input: RecordSupplierOrderRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<SupplierBatch>>;
  cancelSupplierOrder(
    actor: AuthenticatedPrincipal,
    eventId: string,
    input: CancelSupplierOrderRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<SupplierBatch>>;
  recordSupplierSourceReturn(
    actor: AuthenticatedPrincipal,
    input: RecordSupplierSourceReturnRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<SupplierBatch>>;
}

export interface WarehouseRepository extends SupplierReconciliationRepository {
  ready(): Promise<boolean>;
  close(): Promise<void>;

  findCredentials(username: string): Promise<AccountCredentials | null>;
  createSession(
    account: AccountCredentials,
    token: string,
    expiresAt: Date,
    context: RequestContext,
  ): Promise<Session>;
  resolveSession(token: string): Promise<Session>;
  revokeSession(token: string, reason: string): Promise<boolean>;
  /**
   * Activity of the sessions behind the given tokens, keyed by token. Unknown tokens are absent;
   * revoked or expired ones are reported inactive. Used to clean up per-tab cookies.
   */
  inspectSessions(tokens: readonly string[]): Promise<ReadonlyMap<string, SessionActivity>>;

  /** Revalidates the STORE principal against the current store kind and status. */
  authorizeRetailStoreOperation(actor: AuthenticatedPrincipal): Promise<void>;

  listAccounts(actor: AuthenticatedPrincipal, query: ListAccountsQuery): Promise<Page<Account>>;
  createAccount(
    actor: AuthenticatedPrincipal,
    input: CreateAccountRequest,
    context: RequestContext,
  ): Promise<Account>;
  updateAccount(
    actor: AuthenticatedPrincipal,
    accountId: string,
    input: UpdateAccountRequest,
    context: RequestContext,
  ): Promise<Account>;
  resetAccountPassword(
    actor: AuthenticatedPrincipal,
    accountId: string,
    input: ResetPasswordRequest,
    context: RequestContext,
  ): Promise<{
    readonly accountId: string;
    readonly sessionsRevoked: number;
    readonly sessionVersion: number;
  }>;
  listHtkdAssignments(
    actor: AuthenticatedPrincipal,
    htkdAccountId: string,
  ): Promise<HtkdAssignmentsState>;
  replaceHtkdAssignments(
    actor: AuthenticatedPrincipal,
    htkdAccountId: string,
    input: ReplaceHtkdAssignmentsRequest,
    context: RequestContext,
  ): Promise<HtkdAssignmentsState>;
  listAuditLogs(
    actor: AuthenticatedPrincipal,
    query: ListAuditLogsQuery,
  ): Promise<Page<AdminAuditLog>>;
  getOperationalSettings(
    actor: AuthenticatedPrincipal,
    historyLimit: number,
  ): Promise<OperationalSettingsState>;
  updateOperationalSettings(
    actor: AuthenticatedPrincipal,
    input: UpdateOperationalSettingsRequest,
    context: RequestContext,
  ): Promise<OperationalSettingsVersion>;
  /** Last heartbeat of the allocation worker, for the Admin failure notice. */
  getAllocationWorkerStatus(actor: AuthenticatedPrincipal): Promise<WorkerStatus>;
  /** Active retail stores with the IDOSI id set on them in the app (ADMIN). */
  listIdosiStoreCodes(actor: AuthenticatedPrincipal): Promise<readonly IdosiStoreCodeRecord[]>;
  setIdosiStoreCode(
    actor: AuthenticatedPrincipal,
    storeId: string,
    input: SetIdosiStoreCodeRequest,
    context: RequestContext,
  ): Promise<IdosiStoreCodeRecord>;
  /** IDOSI product links and the IDOSI products of a month that no link covers (ADMIN). */
  getIdosiProductMatching(
    actor: AuthenticatedPrincipal,
    period: string,
  ): Promise<IdosiProductMatching>;
  setIdosiProductLink(
    actor: AuthenticatedPrincipal,
    idosiProductId: string,
    input: SetIdosiProductLinkRequest,
    context: RequestContext,
  ): Promise<IdosiProductLink>;

  resolveIdosiStatisticsTarget(
    actor: AuthenticatedPrincipal,
    storeId: string,
  ): Promise<IdosiStatisticsTarget>;
  getIdosiStatisticsState(
    actor: AuthenticatedPrincipal,
    scope: IdosiStatisticsScope,
  ): Promise<PersistedIdosiStatisticsState>;
  getIdosiStatisticsStates(
    actor: AuthenticatedPrincipal,
    storeIds: readonly string[],
    period: string,
  ): Promise<PersistedIdosiStatisticsState[]>;
  recordIdosiStatisticsSuccess(
    actor: AuthenticatedPrincipal,
    scope: IdosiStatisticsScope,
    payload: IdosiOrderStatisticsPayload,
    startedAt: Date,
    completedAt: Date,
    context: RequestContext,
  ): Promise<void>;
  recordIdosiStatisticsFailure(
    actor: AuthenticatedPrincipal,
    scope: IdosiStatisticsScope,
    errorCode: string,
    errorMessage: string,
    startedAt: Date,
    completedAt: Date,
    context: RequestContext,
  ): Promise<void>;

  listOrderSessions(query: ListOrderSessionsQuery): Promise<Page<OrderSession>>;
  prepareOrderingContext(
    actor: AuthenticatedPrincipal,
    storeId: string,
    context: RequestContext,
  ): Promise<OrderingContext>;
  listSessionDocuments(
    actor: AuthenticatedPrincipal,
    query: ListSessionDocumentsQuery,
  ): Promise<Page<SessionDocument>>;
  /** Store decisions on published results, scoped to the actor; PENDING is the notice source. */
  listAllocationDecisions(
    actor: AuthenticatedPrincipal,
    query: ListAllocationDecisionsQuery,
  ): Promise<Page<AllocationDecision>>;
  getAllocationDecision(
    actor: AuthenticatedPrincipal,
    decisionId: string,
    view?: AllocationDecisionView,
  ): Promise<AllocationDecisionDetail>;
  respondAllocationDecision(
    actor: AuthenticatedPrincipal,
    decisionId: string,
    input: RespondAllocationDecisionRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
    view?: AllocationDecisionView,
  ): Promise<IdempotentResource<AllocationDecisionDetail>>;
  /** "Lịch sử đặt hàng theo phân bổ": RE orders and results waiting for an answer, scoped. */
  listReshareOrders(
    actor: AuthenticatedPrincipal,
    query: ListReshareOrdersQuery,
  ): Promise<ListReshareOrdersResponse>;
  updateReshareOrderStatus(
    actor: AuthenticatedPrincipal,
    decisionId: string,
    input: UpdateReshareOrderStatusRequest,
    key: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<ReshareOrderStatusUpdate>>;
  /** Status history of one result; 404 outside the reader's Reshare scope. */
  listReshareStatusHistory(
    actor: AuthenticatedPrincipal,
    decisionId: string,
    query: ReshareStatusHistoryQuery,
  ): Promise<ReshareStatusHistoryResponse>;
  /** Store filter options of the Reshare module (its own scope, not the global store list). */
  listReshareStores(actor: AuthenticatedPrincipal): Promise<ListReshareStoresResponse>;
  listAllocations(
    actor: AuthenticatedPrincipal,
    query: ListAllocationsQuery,
  ): Promise<Page<AllocationResult>>;
  createOrderSession(
    actor: AuthenticatedPrincipal,
    input: CreateOrderSessionRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<OrderSession>>;
  transitionOrderSession(
    actor: AuthenticatedPrincipal,
    sessionId: string,
    input: TransitionOrderSessionRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<OrderSession>>;

  /** ADMIN: every store; HTKD: assigned stores only. Original requests, newest first. */
  listOrderHistory(
    actor: AuthenticatedPrincipal,
    query: ListOrderHistoryQuery,
  ): Promise<Page<OrderHistoryEntry>>;

  listWarehouseBalances(actor: AuthenticatedPrincipal): Promise<WarehouseBalancesResponse>;
  /** Read-only for every role in WAREHOUSE_INVENTORY_READ_ROLES. */
  listWarehouseInventory(
    actor: AuthenticatedPrincipal,
    query: WarehouseInventoryQuery,
  ): Promise<WarehouseInventoryResponse>;
  /** ADMIN only. Changes on-hand bags of the central warehouse through the ledger. */
  createWarehouseStockAdjustment(
    actor: AuthenticatedPrincipal,
    input: CreateWarehouseStockAdjustmentRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<WarehouseStockAdjustment>>;
  listWarehouseStockAdjustments(
    actor: AuthenticatedPrincipal,
    query: ListWarehouseStockAdjustmentsQuery,
  ): Promise<Page<WarehouseStockAdjustment>>;
  getWarehouseStockAdjustment(
    actor: AuthenticatedPrincipal,
    adjustmentId: string,
  ): Promise<WarehouseStockAdjustment>;
  listWarehouseShortageChecks(
    actor: AuthenticatedPrincipal,
    query: ListWarehouseShortageChecksQuery,
  ): Promise<Page<WarehouseShortageCheck>>;
  resolveWarehouseShortageCheck(
    actor: AuthenticatedPrincipal,
    checkId: string,
    input: ResolveWarehouseShortageCheckRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<WarehouseShortageCheck>>;
  listInboundReceipts(
    actor: AuthenticatedPrincipal,
    query: ListInboundReceiptsQuery,
  ): Promise<Page<InboundReceipt>>;
  getInboundReceipt(actor: AuthenticatedPrincipal, receiptId: string): Promise<InboundReceipt>;
  receiveSupplierInbound(
    actor: AuthenticatedPrincipal,
    input: CreateInboundReceiptRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<InboundReceipt>>;
  confirmSupplierInboundCosts(
    actor: AuthenticatedPrincipal,
    receiptId: string,
    input: ConfirmReceiptCostsRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<InboundReceipt>>;
  cancelSupplierInbound(
    actor: AuthenticatedPrincipal,
    receiptId: string,
    input: CancelInboundReceiptRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<InboundReceipt>>;

  listProducts(query: ListProductsQuery): Promise<Page<Product>>;
  createProduct(
    actor: AuthenticatedPrincipal,
    input: CreateProductRequest,
    context: RequestContext,
  ): Promise<Product>;
  updateProduct(
    actor: AuthenticatedPrincipal,
    productId: string,
    input: UpdateProductRequest,
    context: RequestContext,
  ): Promise<Product>;
  listProductConversions(
    productId: string,
    query: ListProductConversionsQuery,
  ): Promise<Page<ProductConversion>>;
  listAllProductConversions(query: ListProductConversionsQuery): Promise<Page<ProductConversion>>;
  /** Creates v1, or atomically appends after the latest version has been explicitly retired. */
  createProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    input: CreateProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion>;
  replaceProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    conversionId: string,
    input: UpdateProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion>;
  retireProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    conversionId: string,
    input: DeleteProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion>;

  listStores(actor: AuthenticatedPrincipal, query: ListStoresQuery): Promise<Page<Store>>;
  listStoreGroups(
    actor: AuthenticatedPrincipal,
    query: ListStoreGroupsQuery,
  ): Promise<Page<StoreGroup>>;
  createStoreGroup(
    actor: AuthenticatedPrincipal,
    input: CreateStoreGroupRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreGroup>>;
  updateStoreGroup(
    actor: AuthenticatedPrincipal,
    groupId: string,
    input: UpdateStoreGroupRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreGroup>>;
  createStore(
    actor: AuthenticatedPrincipal,
    input: CreateStoreRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<Store>>;
  updateStore(
    actor: AuthenticatedPrincipal,
    storeId: string,
    input: UpdateStoreRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<Store>>;

  listOrderRequests(
    actor: AuthenticatedPrincipal,
    query: ListStoreOrderRequestsQuery,
  ): Promise<Page<StoreOrderRequest>>;
  submitOrderRequest(
    actor: AuthenticatedPrincipal,
    input: CreateStoreOrderRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<SubmittedOrderRequest>;
  cancelOrderRequest(
    actor: AuthenticatedPrincipal,
    requestId: string,
    input: CancelStoreOrderRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreOrderRequest>>;

  listWarehouseOutboundRequests(
    actor: AuthenticatedPrincipal,
    query: ListWarehouseOutboundRequestsQuery,
  ): Promise<Page<WarehouseOutboundRequest>>;
  dispatchWarehouseOutboundRequest(
    actor: AuthenticatedPrincipal,
    outboundRequestId: string,
    input: DispatchWarehouseOutboundRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<WarehouseOutboundRequest>>;

  listStorePartnerInbounds(
    actor: AuthenticatedPrincipal,
    query: ListStorePartnerInboundsQuery,
  ): Promise<Page<StorePartnerInbound>>;
  getStorePartnerInbound(
    actor: AuthenticatedPrincipal,
    partnerInboundId: string,
  ): Promise<StorePartnerInbound>;
  createStorePartnerInbound(
    actor: AuthenticatedPrincipal,
    input: CreateStorePartnerInboundRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StorePartnerInbound>>;

  listReceiptSummaries(
    actor: AuthenticatedPrincipal,
    query: ListReceiptsQuery,
  ): Promise<Page<ReceiptSummary>>;
  listReceipts(actor: AuthenticatedPrincipal, query: ListReceiptsQuery): Promise<Page<Receipt>>;
  listStoreReceiptSources(
    actor: AuthenticatedPrincipal,
    query: ListStoreReceiptSourcesQuery,
  ): Promise<Page<StoreReceiptSource>>;
  /** Allocated priority goods held for the store's next ordinary order; scoped server-side. */
  listHeldAllocations(
    actor: AuthenticatedPrincipal,
    query: ListHeldAllocationsQuery,
  ): Promise<HeldAllocation[]>;
  getReceipt(actor: AuthenticatedPrincipal, receiptId: string): Promise<Receipt>;
  declareStoreReceipt(
    actor: AuthenticatedPrincipal,
    input: DeclareStoreReceiptRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<Receipt>>;
  submitStoreReceipt(
    actor: AuthenticatedPrincipal,
    receiptId: string,
    input: SubmitStoreReceiptRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<Receipt>>;
  returnStoreReceiptForCorrection(
    actor: AuthenticatedPrincipal,
    receiptId: string,
    input: ReturnReceiptForCorrectionRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<Receipt>>;
  getReceiptVatConfiguration(
    actor: AuthenticatedPrincipal,
    receiptId: string,
  ): Promise<{ ratePercent: number; version: number }>;
  finalizeStoreReceipt(
    actor: AuthenticatedPrincipal,
    receiptId: string,
    input: FinalizeReceiptRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<Receipt>>;

  /** Bags of a finalized receipt with their effective state, dependencies and adjustments. */
  getReceiptAdjustmentContext(
    actor: AuthenticatedPrincipal,
    receiptId: string,
  ): Promise<ReceiptAdjustmentContext>;
  listReceiptAdjustments(
    actor: AuthenticatedPrincipal,
    query: ListReceiptAdjustmentsQuery,
  ): Promise<Page<ReceiptAdjustmentListItem>>;
  getReceiptAdjustment(
    actor: AuthenticatedPrincipal,
    adjustmentId: string,
  ): Promise<ReceiptAdjustment>;
  /** Immutable audit trail of one adjustment and its returns, scoped to the document's store. */
  listReceiptAdjustmentHistory(
    actor: AuthenticatedPrincipal,
    adjustmentId: string,
    query: ReceiptAdjustmentHistoryQuery,
  ): Promise<Page<ReceiptAdjustmentHistoryEvent>>;
  createReceiptAdjustment(
    actor: AuthenticatedPrincipal,
    input: CreateReceiptAdjustmentRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<ReceiptAdjustment>>;
  actOnReceiptAdjustment(
    actor: AuthenticatedPrincipal,
    adjustmentId: string,
    input: ReceiptAdjustmentActionRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<ReceiptAdjustment>>;
  createReceiptReturn(
    actor: AuthenticatedPrincipal,
    adjustmentId: string,
    lineId: string,
    input: CreateReceiptReturnRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<ReceiptReturn>>;
  listReceiptReturns(
    actor: AuthenticatedPrincipal,
    query: ListReceiptReturnsQuery,
  ): Promise<Page<ReceiptReturn>>;
  actOnReceiptReturn(
    actor: AuthenticatedPrincipal,
    returnId: string,
    input: ReceiptReturnActionRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<ReceiptReturn>>;

  listStoreBagOpenings(
    actor: AuthenticatedPrincipal,
    query: ListStoreBagOpeningsQuery,
  ): Promise<Page<StoreBagOpening>>;
  listStoreInventoryBags(
    actor: AuthenticatedPrincipal,
    query: ListStoreInventoryBagsQuery,
  ): Promise<Page<StoreInventoryBag>>;
  listStoreInventoryBagLedger(
    actor: AuthenticatedPrincipal,
    bagId: string,
    query: ListStoreInventoryBagLedgerQuery,
  ): Promise<Page<StoreInventoryBagLedgerEntry>>;
  openStoreInventoryBag(
    actor: AuthenticatedPrincipal,
    bagId: string,
    input: OpenStoreInventoryBagRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreInventoryBag>>;
  listStoreOutbounds(
    actor: AuthenticatedPrincipal,
    query: ListStoreOutboundsQuery,
  ): Promise<Page<StoreOutbound>>;
  createStoreOutbound(
    actor: AuthenticatedPrincipal,
    input: CreateStoreOutboundRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreOutbound>>;
  reviewStoreOutbound(
    actor: AuthenticatedPrincipal,
    outboundId: string,
    input: ReviewStoreOutboundRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreOutbound>>;
  listStoreSortedStocks(
    actor: AuthenticatedPrincipal,
    storeId?: string,
  ): Promise<readonly StoreSortedStock[]>;
  /** IDOSI regular-price sales still waiting for an opened bag, per store and product. */
  listStoreNormalSalePending(
    actor: AuthenticatedPrincipal,
    storeId?: string,
  ): Promise<readonly StoreNormalSalePending[]>;
  createStoreSorting(
    actor: AuthenticatedPrincipal,
    input: CreateStoreSortingRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreSortingResult>>;
  moveCharityToSale(
    actor: AuthenticatedPrincipal,
    stockId: string,
    input: MoveCharityToSaleRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreSortingResult>>;
  exportCharity(
    actor: AuthenticatedPrincipal,
    stockId: string,
    input: ExportCharityRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreSortingResult>>;
  moveProductCharityToSale(
    actor: AuthenticatedPrincipal,
    input: MoveProductCharityToSaleRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<ProductCharityBalance>>;
  listCharityExports(
    actor: AuthenticatedPrincipal,
    storeId: string | undefined,
  ): Promise<readonly CharityExport[]>;
  listStoreSortingHistory(
    actor: AuthenticatedPrincipal,
    query: ListStoreSortingHistoryQuery,
  ): Promise<Page<StoreSortingHistoryEntry>>;
  createCharityExport(
    actor: AuthenticatedPrincipal,
    input: CreateCharityExportRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<CharityExport>>;
  moveProductCancelToSale(
    actor: AuthenticatedPrincipal,
    input: MoveProductCancelToSaleRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<ProductCancelBalance>>;
  finalizeProductCancel(
    actor: AuthenticatedPrincipal,
    input: FinalizeProductCancelRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<ProductCancelBalance>>;
  moveProductSaleToCharity(
    actor: AuthenticatedPrincipal,
    input: MoveProductSaleToCharityRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<ProductCharityBalance>>;
  moveProductSaleToCancel(
    actor: AuthenticatedPrincipal,
    input: MoveProductSaleToCancelRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<ProductCancelBalance>>;
  listSaleBreakdown(
    actor: AuthenticatedPrincipal,
    storeId: string | undefined,
  ): Promise<readonly SaleBreakdown[]>;

  listSortedSaleTransfers(
    actor: AuthenticatedPrincipal,
    page?: { page: number; pageSize: number },
  ): Promise<readonly SortedSaleTransfer[]>;
  createSortedSaleTransfer(
    actor: AuthenticatedPrincipal,
    input: CreateSortedSaleTransferRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<SortedSaleTransfer>>;
  receiveSortedSaleTransfer(
    actor: AuthenticatedPrincipal,
    transferId: string,
    input: ReceiveSortedSaleTransferRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<SortedSaleTransfer>>;
  cancelSortedSaleTransfer(
    actor: AuthenticatedPrincipal,
    transferId: string,
    input: CancelSortedSaleTransferRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<SortedSaleTransfer>>;

  listStoreTransfers(
    actor: AuthenticatedPrincipal,
    query: ListStoreTransfersQuery,
  ): Promise<Page<StoreTransfer>>;
  listStoreTransferDestinations(actor: AuthenticatedPrincipal): Promise<readonly Store[]>;
  createStoreTransfer(
    actor: AuthenticatedPrincipal,
    input: CreateStoreTransferRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreTransfer>>;
  dispatchStoreTransfer(
    actor: AuthenticatedPrincipal,
    transferId: string,
    input: DispatchStoreTransferRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreTransfer>>;
  receiveStoreTransfer(
    actor: AuthenticatedPrincipal,
    transferId: string,
    input: ReceiveStoreTransferRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreTransfer>>;
  cancelStoreTransfer(
    actor: AuthenticatedPrincipal,
    transferId: string,
    input: CancelStoreTransferRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<StoreTransfer>>;

  listWaitTickets(
    actor: AuthenticatedPrincipal,
    query: ListWaitTicketsQuery,
  ): Promise<Page<WaitTicket>>;
  getWaitTicketHistory(
    actor: AuthenticatedPrincipal,
    waitTicketId: string,
    limit: number,
  ): Promise<WaitTicketHistory>;
  /** Read-only scope of "Hủy phiếu chờ": waiting demand, holds, revocable and protected goods. */
  previewWaitTicketCancellation(
    actor: AuthenticatedPrincipal,
    waitTicketId: string,
  ): Promise<WaitTicketCancelPreview>;
  cancelWaitTicket(
    actor: AuthenticatedPrincipal,
    waitTicketId: string,
    input: CancelWaitTicketRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<WaitTicket>>;
  /** Store wait documents ("phiếu chờ"), scoped by the live principal on every call. */
  listStoreWaitDocuments(
    actor: AuthenticatedPrincipal,
    query: ListStoreWaitDocumentsQuery,
  ): Promise<ListStoreWaitDocumentsResponse>;
  getStoreWaitDocument(
    actor: AuthenticatedPrincipal,
    documentId: string,
  ): Promise<StoreWaitDocumentDetail>;
  previewStoreWaitDocumentCancellation(
    actor: AuthenticatedPrincipal,
    documentId: string,
  ): Promise<StoreWaitDocumentCancelPreview>;
  cancelStoreWaitDocument(
    actor: AuthenticatedPrincipal,
    documentId: string,
    input: CancelStoreWaitDocumentRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<CancelledStoreWaitDocument>>;
  listPriorityOffers(
    actor: AuthenticatedPrincipal,
    query: ListPriorityOffersQuery,
  ): Promise<Page<PriorityOffer>>;
  respondPriorityOffer(
    actor: AuthenticatedPrincipal,
    offerId: string,
    input: RespondPriorityOfferRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<PriorityOffer>>;

  getInboundStatistics(
    actor: AuthenticatedPrincipal,
    query: InboundStatisticsQuery,
  ): Promise<InboundStatistics>;

  getMonthlyOperationalReport(
    actor: AuthenticatedPrincipal,
    query: MonthlyOperationalReportQuery,
  ): Promise<MonthlyOperationalReport>;

  getOrderStatistics(
    actor: AuthenticatedPrincipal,
    storeCode: string,
    from: string,
    to: string,
  ): Promise<OrderStatistics>;
}

/**
 * The receiving side of a store answers its allocation results: a store account for its own
 * active retail store, the wholesale desk for an active wholesale store in its scope (the same
 * parties that declare receipts). Admin and HTKD can read results but never answer for a store.
 */
/** Opt-in response fields of allocation decisions (older bundles validate the strict shape). */
export interface AllocationDecisionView {
  readonly includeReshare?: boolean;
  /** 0044: WAITLISTED/CANCELLED statuses, WAITLIST action and revocation details. */
  readonly includeWaitlist?: boolean;
}

export function mayAnswerAllocationDecision(
  principal: AuthenticatedPrincipal,
  store: { readonly id: string; readonly kind: 'RETAIL' | 'WHOLESALE'; readonly active: boolean },
): boolean {
  return allocationDecisionActionsFor(principal, store).length > 0;
}

/**
 * Actions the account may take on a pending result of this store: "Xác nhận phân bổ" (ACCEPT)
 * and "Chuyển phiếu chờ" (WAITLIST), for the receiving side and for an HTKD assigned to the
 * active store. Uses the allocation scope (assignments), never the Reshare-wide HTKD scope. The
 * database re-checks the live account, store and assignment inside the command transaction.
 */
export function allocationDecisionActionsFor(
  principal: AuthenticatedPrincipal,
  store: { readonly id: string; readonly kind: 'RETAIL' | 'WHOLESALE'; readonly active: boolean },
): readonly ('ACCEPT' | 'WAITLIST')[] {
  if (!store.active) return [];
  if (principal.role === 'STORE') {
    return principal.storeId === store.id && store.kind === 'RETAIL' ? ['ACCEPT', 'WAITLIST'] : [];
  }
  if (principal.role === 'WHOLESALE') {
    return principal.assignedStoreIds.includes(store.id) && store.kind === 'WHOLESALE'
      ? ['ACCEPT', 'WAITLIST']
      : [];
  }
  if (principal.role === 'HTKD') {
    return principal.assignedStoreIds.includes(store.id) ? ['ACCEPT', 'WAITLIST'] : [];
  }
  return [];
}

/**
 * "Đơn & tồn Reshare" is managed by Admin and every active HTKD for all stores; the HTKD store
 * assignments narrow every other module but not this one. Store and wholesale accounts keep
 * reading their own stores only. Never use this outside the Reshare module.
 */
export const RESHARE_MANAGER_FORBIDDEN_MESSAGE =
  'Chỉ Admin hoặc HTKD được đối chiếu và cấu hình nguồn Reshare.';

export function isReshareManager(principal: AuthenticatedPrincipal): boolean {
  return principal.role === 'ADMIN' || principal.role === 'HTKD';
}

/** Reshare read scope; undefined means every store (Reshare managers). */
export function reshareStoreScope(
  principal: AuthenticatedPrincipal,
  storeId: string | undefined,
): readonly string[] | undefined {
  if (isReshareManager(principal)) return storeId === undefined ? undefined : [storeId];
  if (storeId !== undefined) {
    if (!canAccessStore(principal, storeId)) throw forbidden();
    return [storeId];
  }
  if (principal.role === 'STORE') return principal.storeId === null ? [] : [principal.storeId];
  return principal.assignedStoreIds;
}

export function canAccessStore(principal: AuthenticatedPrincipal, storeId: string): boolean {
  if (principal.role === 'ADMIN') return true;
  if (principal.role === 'STORE') return principal.storeId === storeId;
  return principal.assignedStoreIds.includes(storeId);
}

export function pagination(page: number, pageSize: number, totalItems: number): PaginationMeta {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  };
}

export function slicePage<T>(values: readonly T[], page: number, pageSize: number): readonly T[] {
  const start = (page - 1) * pageSize;
  return values.slice(start, start + pageSize);
}
