import { randomUUID } from 'node:crypto';

import type {
  AuthenticatedPrincipal,
  CreateProductConversionRequest,
  CreateProductRequest,
  CreateStoreOrderRequest,
  CreateStoreRequest,
  ListOrderSessionsQuery,
  ListProductsQuery,
  ListProductConversionsQuery,
  ListStoreOrderRequestsQuery,
  ListStoresQuery,
  Product,
  ProductConversion,
  OrderSession,
  Session,
  Store,
  StoreOrderRequest,
  UpdateProductRequest,
  UpdateProductConversionRequest,
  DeleteProductConversionRequest,
} from '@idosi/contracts';
import {
  PRODUCT_CONVERSION_SEEDS,
  PRODUCT_SEEDS,
  STORE_GROUP_SEEDS,
  STORE_SEEDS,
} from '@idosi/database/seed-data';

import { ApiError, conflict, forbidden, notFound, unauthenticated } from './errors.js';
import type {
  AccountCredentials,
  OrderStatistics,
  Page,
  RequestContext,
  SubmittedOrderRequest,
  WarehouseRepository,
} from './repository.js';
import { canAccessStore, pagination, slicePage } from './repository.js';
import { hashPassword, hashSessionToken } from './security.js';

export const MEMORY_SEED_IDS = {
  adminAccount: '00000000-0000-4000-8000-000000000001',
  htkdAccount: '00000000-0000-4000-8000-000000000002',
  storeAccount: '00000000-0000-4000-8000-000000000003',
  orderSession: '10000000-0000-4000-8000-000000000001',
  nvtStore: '20000000-0000-4000-8000-000000000007',
  bdStore: '20000000-0000-4000-8000-000000000008',
} as const;

interface MutableAccount extends AccountCredentials {
  passwordHash: string;
  sessionVersion: number;
  status: 'ACTIVE' | 'LOCKED' | 'DISABLED';
}

interface StoredSession {
  readonly id: string;
  readonly tokenHash: string;
  readonly accountId: string;
  readonly accountSessionVersion: number;
  readonly createdAt: Date;
  lastSeenAt: Date;
  readonly expiresAt: Date;
  revokedAt: Date | null;
}

interface IdempotencyRecord {
  readonly requestHash: string;
  readonly response: StoreOrderRequest;
}

interface AuditRecord {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorAccountId: string;
  readonly requestId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly createdAt: string;
}

export interface MemoryRepositoryOptions {
  readonly bootstrapPassword?: string;
  readonly now?: () => Date;
}

/** Deterministic in-memory adapter for inject tests and local demos. Never used by default in production. */
export class MemoryWarehouseRepository implements WarehouseRepository {
  private readonly now: () => Date;
  private readonly accounts = new Map<string, MutableAccount>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly stores = new Map<string, Store>();
  private readonly orderSessions = new Map<string, OrderSession>();
  private readonly products = new Map<string, Product>();
  private readonly productConversions = new Map<string, ProductConversion>();
  private readonly orderRequests = new Map<string, StoreOrderRequest>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly storeGroupIds = new Set<string>();
  private readonly audit: AuditRecord[] = [];

  private constructor(now: () => Date) {
    this.now = now;
  }

  public static async create(
    options: MemoryRepositoryOptions = {},
  ): Promise<MemoryWarehouseRepository> {
    const repository = new MemoryWarehouseRepository(options.now ?? (() => new Date()));
    await repository.seed(options.bootstrapPassword ?? 'IDOSI-local-only-2026!');
    return repository;
  }

  public async ready(): Promise<boolean> {
    return true;
  }

  public async close(): Promise<void> {
    // There are no external resources in memory mode.
  }

  public async findCredentials(username: string): Promise<AccountCredentials | null> {
    const normalized = username.trim();
    return [...this.accounts.values()].find((account) => account.username === normalized) ?? null;
  }

  public async createSession(
    account: AccountCredentials,
    token: string,
    expiresAt: Date,
    _context: RequestContext,
  ): Promise<Session> {
    const createdAt = this.now();
    const stored: StoredSession = {
      id: randomUUID(),
      tokenHash: hashSessionToken(token),
      accountId: account.id,
      accountSessionVersion: account.sessionVersion,
      createdAt,
      lastSeenAt: createdAt,
      expiresAt,
      revokedAt: null,
    };
    this.sessions.set(stored.tokenHash, stored);
    return this.toSession(stored, account);
  }

  public async resolveSession(token: string): Promise<Session> {
    const stored = this.sessions.get(hashSessionToken(token));
    const now = this.now();
    if (!stored || stored.revokedAt !== null || stored.expiresAt.getTime() <= now.getTime()) {
      throw unauthenticated();
    }
    const account = this.accounts.get(stored.accountId);
    if (!account || account.sessionVersion !== stored.accountSessionVersion) {
      throw new ApiError('SESSION_REVOKED', 'Phiên đăng nhập đã bị thu hồi', 401);
    }
    if (account.status !== 'ACTIVE') {
      throw new ApiError('ACCOUNT_INACTIVE', 'Tài khoản đã bị khóa hoặc vô hiệu hóa', 403);
    }
    stored.lastSeenAt = now;
    return this.toSession(stored, account);
  }

  public async revokeSession(token: string, _reason: string): Promise<boolean> {
    const stored = this.sessions.get(hashSessionToken(token));
    if (!stored || stored.revokedAt !== null) return false;
    stored.revokedAt = this.now();
    return true;
  }

  public async listOrderSessions(query: ListOrderSessionsQuery): Promise<Page<OrderSession>> {
    const values = [...this.orderSessions.values()]
      .filter((session) => query.status === undefined || session.status === query.status)
      .filter((session) => query.dateFrom === undefined || session.businessDate >= query.dateFrom)
      .filter((session) => query.dateTo === undefined || session.businessDate <= query.dateTo)
      .sort((left, right) => right.businessDate.localeCompare(left.businessDate));
    return {
      data: slicePage(values, query.page, query.pageSize),
      pagination: pagination(query.page, query.pageSize, values.length),
    };
  }

  public async listProducts(query: ListProductsQuery): Promise<Page<Product>> {
    const search = query.search?.toLocaleLowerCase('vi-VN');
    const values = [...this.products.values()]
      .filter((product) => query.status === undefined || product.status === query.status)
      .filter(
        (product) => query.measurement === undefined || product.measurement === query.measurement,
      )
      .filter(
        (product) =>
          search === undefined ||
          product.name.toLocaleLowerCase('vi-VN').includes(search) ||
          product.sku.toLocaleLowerCase('en-US').includes(search),
      )
      .sort((left, right) => left.sku.localeCompare(right.sku));
    return {
      data: slicePage(values, query.page, query.pageSize),
      pagination: pagination(query.page, query.pageSize, values.length),
    };
  }

  public async createProduct(
    actor: AuthenticatedPrincipal,
    input: CreateProductRequest,
    context: RequestContext,
  ): Promise<Product> {
    if ([...this.products.values()].some((product) => product.sku === input.sku)) {
      throw conflict('Mã SKU đã tồn tại');
    }
    const now = this.now().toISOString();
    const product: Product = {
      id: randomUUID(),
      ...input,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    this.products.set(product.id, product);
    this.appendAudit(actor, context, 'PRODUCT_CREATED', 'product', product.id, null, product);
    return product;
  }

  public async updateProduct(
    actor: AuthenticatedPrincipal,
    productId: string,
    input: UpdateProductRequest,
    context: RequestContext,
  ): Promise<Product> {
    const current = this.products.get(productId);
    if (!current) throw notFound('Không tìm thấy mặt hàng');
    const updated: Product = {
      ...current,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.unitLabel !== undefined ? { unitLabel: input.unitLabel } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: this.now().toISOString(),
    };
    this.products.set(productId, updated);
    this.appendAudit(actor, context, 'PRODUCT_UPDATED', 'product', productId, current, updated);
    return updated;
  }

  public async listProductConversions(
    productId: string,
    query: ListProductConversionsQuery,
  ): Promise<Page<ProductConversion>> {
    if (!this.products.has(productId)) throw notFound('Không tìm thấy mặt hàng');
    const values = [...this.productConversions.values()]
      .filter((conversion) => conversion.productId === productId)
      .filter(
        (conversion) =>
          query.includeRetired || query.effectiveAt !== undefined || conversion.retiredAt === null,
      )
      .filter(
        (conversion) =>
          query.effectiveAt === undefined ||
          (conversion.effectiveFrom <= query.effectiveAt &&
            (conversion.effectiveTo === null || query.effectiveAt < conversion.effectiveTo)),
      )
      .sort((left, right) => right.version - left.version);
    return {
      data: slicePage(values, query.page, query.pageSize),
      pagination: pagination(query.page, query.pageSize, values.length),
    };
  }

  public async listAllProductConversions(
    query: ListProductConversionsQuery,
  ): Promise<Page<ProductConversion>> {
    const values = [...this.productConversions.values()]
      .filter(
        (conversion) =>
          query.includeRetired || query.effectiveAt !== undefined || conversion.retiredAt === null,
      )
      .filter(
        (conversion) =>
          query.effectiveAt === undefined ||
          (conversion.effectiveFrom <= query.effectiveAt &&
            (conversion.effectiveTo === null || query.effectiveAt < conversion.effectiveTo)),
      )
      .sort(
        (left, right) =>
          left.productId.localeCompare(right.productId) || right.version - left.version,
      );
    return {
      data: slicePage(values, query.page, query.pageSize),
      pagination: pagination(query.page, query.pageSize, values.length),
    };
  }

  public async createProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    input: CreateProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion> {
    if (!this.products.has(productId)) throw notFound('Không tìm thấy mặt hàng');
    if ([...this.productConversions.values()].some((item) => item.productId === productId)) {
      throw conflict('Mặt hàng đã có lịch sử quy đổi; hãy tạo phiên bản kế tiếp bằng PATCH');
    }
    const conversion: ProductConversion = {
      id: randomUUID(),
      productId,
      version: 1,
      ...input,
      createdByAccountId: actor.accountId,
      createdAt: this.now().toISOString(),
      retiredAt: null,
      retiredByAccountId: null,
      retirementReason: null,
    };
    this.productConversions.set(conversion.id, conversion);
    this.appendAudit(
      actor,
      context,
      'PRODUCT_CONVERSION_CREATED',
      'product_conversion',
      conversion.id,
      null,
      conversion,
    );
    return conversion;
  }

  public async replaceProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    conversionId: string,
    input: UpdateProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion> {
    const current = this.productConversions.get(conversionId);
    if (!current || current.productId !== productId) throw notFound('Không tìm thấy tỷ lệ quy đổi');
    if (current.version !== input.expectedVersion) {
      throw new ApiError('VERSION_CONFLICT', 'Phiên bản tỷ lệ quy đổi đã thay đổi', 409);
    }
    if (current.retiredAt !== null)
      throw conflict('Tỷ lệ quy đổi đã được thay thế hoặc ngừng dùng');
    if (input.effectiveFrom <= current.effectiveFrom) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'Ngày hiệu lực của phiên bản mới phải sau phiên bản hiện tại',
        400,
      );
    }
    const retired: ProductConversion = {
      ...current,
      effectiveTo: input.effectiveFrom,
      retiredAt: this.now().toISOString(),
      retiredByAccountId: actor.accountId,
      retirementReason: input.reason,
    };
    const replacement: ProductConversion = {
      id: randomUUID(),
      productId,
      version: current.version + 1,
      itemQuantity: input.itemQuantity,
      weightKilograms: input.weightKilograms,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      reason: input.reason,
      createdByAccountId: actor.accountId,
      createdAt: this.now().toISOString(),
      retiredAt: null,
      retiredByAccountId: null,
      retirementReason: null,
    };
    this.productConversions.set(current.id, retired);
    this.productConversions.set(replacement.id, replacement);
    this.appendAudit(
      actor,
      context,
      'PRODUCT_CONVERSION_REPLACED',
      'product_conversion',
      replacement.id,
      current,
      replacement,
    );
    return replacement;
  }

  public async retireProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    conversionId: string,
    input: DeleteProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion> {
    const current = this.productConversions.get(conversionId);
    if (!current || current.productId !== productId) throw notFound('Không tìm thấy tỷ lệ quy đổi');
    if (current.version !== input.expectedVersion) {
      throw new ApiError('VERSION_CONFLICT', 'Phiên bản tỷ lệ quy đổi đã thay đổi', 409);
    }
    if (current.retiredAt !== null) return current;
    const retired: ProductConversion = {
      ...current,
      effectiveTo: retirementDate(current.effectiveFrom, this.now()),
      retiredAt: this.now().toISOString(),
      retiredByAccountId: actor.accountId,
      retirementReason: input.reason,
    };
    this.productConversions.set(current.id, retired);
    this.appendAudit(
      actor,
      context,
      'PRODUCT_CONVERSION_RETIRED',
      'product_conversion',
      current.id,
      current,
      retired,
    );
    return retired;
  }

  public async listStores(
    actor: AuthenticatedPrincipal,
    query: ListStoresQuery,
  ): Promise<Page<Store>> {
    const search = query.search?.toLocaleLowerCase('vi-VN');
    const values = [...this.stores.values()]
      .filter((store) => canAccessStore(actor, store.id))
      .filter((store) => query.status === undefined || store.status === query.status)
      .filter((store) => query.kind === undefined || store.kind === query.kind)
      .filter((store) => query.groupId === undefined || store.groupId === query.groupId)
      .filter(
        (store) =>
          search === undefined ||
          store.name.toLocaleLowerCase('vi-VN').includes(search) ||
          store.code.toLocaleLowerCase('en-US').includes(search),
      )
      .sort((left, right) => left.code.localeCompare(right.code));
    return {
      data: slicePage(values, query.page, query.pageSize),
      pagination: pagination(query.page, query.pageSize, values.length),
    };
  }

  public async createStore(
    actor: AuthenticatedPrincipal,
    input: CreateStoreRequest,
    context: RequestContext,
  ): Promise<Store> {
    if (input.groupId === null || !this.storeGroupIds.has(input.groupId)) {
      throw new ApiError('VALIDATION_ERROR', 'Cửa hàng phải thuộc một nhóm hợp lệ', 400, {
        field: 'groupId',
      });
    }
    if ([...this.stores.values()].some((store) => store.code === input.code)) {
      throw conflict('Mã cửa hàng đã tồn tại');
    }
    const now = this.now().toISOString();
    const store: Store = {
      id: randomUUID(),
      code: input.code,
      name: input.name,
      groupId: input.groupId,
      kind: input.kind,
      address: input.address,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    this.stores.set(store.id, store);
    this.appendAudit(actor, context, 'STORE_CREATED', 'store', store.id, null, store);
    return store;
  }

  public async listOrderRequests(
    actor: AuthenticatedPrincipal,
    query: ListStoreOrderRequestsQuery,
  ): Promise<Page<StoreOrderRequest>> {
    if (query.storeId !== undefined && !canAccessStore(actor, query.storeId)) throw forbidden();
    const values = [...this.orderRequests.values()]
      .filter((request) => canAccessStore(actor, request.storeId))
      .filter((request) => query.storeId === undefined || request.storeId === query.storeId)
      .filter((request) => query.sessionId === undefined || request.sessionId === query.sessionId)
      .filter((request) => query.status === undefined || request.status === query.status)
      .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
    return {
      data: slicePage(values, query.page, query.pageSize),
      pagination: pagination(query.page, query.pageSize, values.length),
    };
  }

  public async submitOrderRequest(
    actor: AuthenticatedPrincipal,
    input: CreateStoreOrderRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<SubmittedOrderRequest> {
    if (!canAccessStore(actor, input.storeId))
      throw forbidden('Không có quyền gửi cho cửa hàng này');
    if (!this.stores.has(input.storeId)) throw notFound('Không tìm thấy cửa hàng');
    const session = this.orderSessions.get(input.businessSessionId);
    if (
      !session ||
      session.status !== 'OPEN' ||
      Date.parse(session.requestClosesAt) <= this.now().getTime()
    ) {
      throw new ApiError('SESSION_NOT_OPEN', 'Phiên đặt hàng chưa mở hoặc đã đóng', 409);
    }
    for (const item of input.items) {
      const product = this.products.get(item.productId);
      if (!product || product.status !== 'ACTIVE')
        throw notFound('Có mặt hàng không tồn tại hoặc đã ngừng dùng');
    }

    const scopedKey = `${actor.accountId}:${idempotencyKey}`;
    const previous = this.idempotency.get(scopedKey);
    if (previous) {
      if (previous.requestHash !== requestHash) {
        throw new ApiError(
          'IDEMPOTENCY_CONFLICT',
          'Khóa idempotency đã được dùng cho nội dung khác',
          409,
        );
      }
      return { data: previous.response, replayed: true };
    }

    // No await occurs between counting and insertion: this is one atomic event-loop turn.
    const existing = [...this.orderRequests.values()].filter(
      (request) =>
        request.sessionId === input.businessSessionId &&
        request.storeId === input.storeId &&
        request.status !== 'CANCELLED',
    );
    if (existing.length >= 2) {
      throw new ApiError(
        'REQUEST_LIMIT_REACHED',
        'Mỗi cửa hàng chỉ được gửi tối đa hai yêu cầu trong một phiên',
        409,
      );
    }

    const now = this.now().toISOString();
    const request: StoreOrderRequest = {
      id: randomUUID(),
      sessionId: input.businessSessionId,
      storeId: input.storeId,
      requestSequence: existing.some((item) => item.requestSequence === 1) ? 2 : 1,
      status: 'SUBMITTED',
      lines: input.items.map((item) => ({
        productId: item.productId,
        requested: { kind: 'UNIT', quantity: item.quantity },
        priority: 'P1',
      })),
      submittedByAccountId: actor.accountId,
      submittedAt: now,
      cancelledAt: null,
    };
    this.orderRequests.set(request.id, request);
    this.idempotency.set(scopedKey, { requestHash, response: request });
    this.appendAudit(
      actor,
      context,
      'ORDER_REQUEST_SUBMITTED',
      'order_request',
      request.id,
      null,
      request,
    );
    return { data: request, replayed: false };
  }

  public async getOrderStatistics(
    actor: AuthenticatedPrincipal,
    storeCode: string,
    from: string,
    to: string,
  ): Promise<OrderStatistics> {
    const store = [...this.stores.values()].find((candidate) => candidate.code === storeCode);
    if (!store) throw notFound('Không tìm thấy cửa hàng');
    if (!canAccessStore(actor, store.id)) throw forbidden('Không có quyền xem cửa hàng này');
    return emptyStatistics(storeCode, from, to, this.now());
  }

  /** Test/admin helper that models token-version revocation when account state changes. */
  public setAccountStatus(accountId: string, status: MutableAccount['status']): void {
    const account = this.accounts.get(accountId);
    if (!account) throw notFound('Không tìm thấy tài khoản');
    account.status = status;
    account.sessionVersion += 1;
  }

  private async seed(password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    const now = this.now().toISOString();
    const sessionOpen = new Date(this.now().getTime() - 60 * 60 * 1_000);
    const sessionClose = new Date(this.now().getTime() + 60 * 60 * 1_000);
    const allocationStart = new Date(this.now().getTime() + 2 * 60 * 60 * 1_000);
    this.orderSessions.set(MEMORY_SEED_IDS.orderSession, {
      id: MEMORY_SEED_IDS.orderSession,
      businessDate: now.slice(0, 10),
      status: 'OPEN',
      requestOpensAt: sessionOpen.toISOString(),
      requestClosesAt: sessionClose.toISOString(),
      allocationStartsAt: allocationStart.toISOString(),
      createdAt: now,
      updatedAt: now,
    });
    const groupIdByCode = new Map<string, string>();
    const groupKindByCode = new Map<string, 'RETAIL' | 'WHOLESALE'>();
    STORE_GROUP_SEEDS.forEach((group, index) => {
      const id = `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      groupIdByCode.set(group.code, id);
      groupKindByCode.set(group.code, group.kind === 'wholesale' ? 'WHOLESALE' : 'RETAIL');
      this.storeGroupIds.add(id);
    });

    STORE_SEEDS.forEach((seed, index) => {
      const id = `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const groupId = groupIdByCode.get(seed.groupCode);
      if (!groupId) throw new Error(`Unknown seed store group ${seed.groupCode}`);
      const kind = groupKindByCode.get(seed.groupCode);
      if (!kind) throw new Error(`Unknown seed store kind ${seed.groupCode}`);
      this.stores.set(id, {
        id,
        code: seed.code,
        name: seed.name,
        groupId,
        kind,
        status: 'ACTIVE',
        address: null,
        createdAt: now,
        updatedAt: now,
      });
    });

    PRODUCT_SEEDS.forEach((seed, index) => {
      const id = `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      this.products.set(id, {
        id,
        sku: seed.sku,
        name: seed.name,
        measurement: 'UNIT',
        unitLabel: 'bao',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
    });

    PRODUCT_CONVERSION_SEEDS.forEach((seed, index) => {
      const product = [...this.products.values()].find(
        (candidate) => candidate.sku === seed.productSku,
      );
      if (!product) throw new Error(`Unknown seed product ${seed.productSku}`);
      const id = `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      this.productConversions.set(id, {
        id,
        productId: product.id,
        version: seed.version,
        itemQuantity: seed.itemQuantity,
        weightKilograms: seed.weightKilograms,
        effectiveFrom: seed.effectiveFrom,
        effectiveTo: seed.effectiveTo,
        reason: seed.reason,
        createdByAccountId: null,
        createdAt: now,
        retiredAt: null,
        retiredByAccountId: null,
        retirementReason: null,
      });
    });

    const nvtId = this.storeIdByCode('DS_NVT');
    const bdId = this.storeIdByCode('DS_BD');
    const seededAccounts: MutableAccount[] = [
      {
        id: MEMORY_SEED_IDS.adminAccount,
        username: 'admin',
        displayName: 'Quản trị IDOSI',
        role: 'ADMIN',
        status: 'ACTIVE',
        storeId: null,
        passwordHash,
        sessionVersion: 0,
        assignedStoreIds: [],
      },
      {
        id: MEMORY_SEED_IDS.htkdAccount,
        username: 'htkd',
        displayName: 'Điều phối HTKD',
        role: 'HTKD',
        status: 'ACTIVE',
        storeId: null,
        passwordHash,
        sessionVersion: 0,
        assignedStoreIds: [nvtId, bdId],
      },
      {
        id: MEMORY_SEED_IDS.storeAccount,
        username: 'ds_nvt',
        displayName: 'Cửa hàng DS NVT',
        role: 'STORE',
        status: 'ACTIVE',
        storeId: nvtId,
        passwordHash,
        sessionVersion: 0,
        assignedStoreIds: [],
      },
    ];
    for (const account of seededAccounts) this.accounts.set(account.id, account);
  }

  private storeIdByCode(code: string): string {
    const store = [...this.stores.values()].find((candidate) => candidate.code === code);
    if (!store) throw new Error(`Unknown seed store ${code}`);
    return store.id;
  }

  private toSession(stored: StoredSession, account: AccountCredentials): Session {
    return {
      id: stored.id,
      principal: {
        accountId: account.id,
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        status: 'ACTIVE',
        storeId: account.storeId,
        assignedStoreIds: [...account.assignedStoreIds],
      },
      createdAt: stored.createdAt.toISOString(),
      lastSeenAt: stored.lastSeenAt.toISOString(),
      expiresAt: stored.expiresAt.toISOString(),
    };
  }

  private appendAudit(
    actor: AuthenticatedPrincipal,
    context: RequestContext,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): void {
    this.audit.push(
      Object.freeze({
        id: randomUUID(),
        action,
        entityType,
        entityId,
        actorAccountId: actor.accountId,
        requestId: context.requestId,
        before: structuredClone(before),
        after: structuredClone(after),
        createdAt: this.now().toISOString(),
      }),
    );
  }
}

function emptyStatistics(storeCode: string, from: string, to: string, now: Date): OrderStatistics {
  return {
    storeCode,
    period: { from, to },
    totals: {
      revenueByType: { NORMAL: 0, SALE_KG: 0, SALE_PIECE: 0 },
      revenue: 0,
      weight: { actualKg: '0.000', estimatedKg: '0.000', totalKg: '0.000', isComplete: true },
    },
    products: [],
    generatedAt: now.toISOString(),
  };
}

function retirementDate(effectiveFrom: string, now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return today > effectiveFrom ? today : effectiveFrom;
}
