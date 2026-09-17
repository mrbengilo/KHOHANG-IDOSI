import type {
  AuthenticatedPrincipal,
  CancelWaitTicketRequest,
  CreateProductConversionRequest,
  CreateProductRequest,
  CreateStoreOrderRequest,
  CreateStoreRequest,
  DeclareStoreReceiptRequest,
  FinalizeReceiptRequest,
  ListOrderSessionsQuery,
  ListPriorityOffersQuery,
  ListProductsQuery,
  ListReceiptsQuery,
  ListProductConversionsQuery,
  ListStoreOrderRequestsQuery,
  ListStoresQuery,
  ListWaitTicketsQuery,
  MonthlyOperationalReport,
  MonthlyOperationalReportQuery,
  Product,
  ProductConversion,
  PriorityOffer,
  Receipt,
  RespondPriorityOfferRequest,
  ReturnReceiptForCorrectionRequest,
  OrderSession,
  Session,
  Store,
  StoreOrderRequest,
  SubmitStoreReceiptRequest,
  UpdateProductRequest,
  UpdateProductConversionRequest,
  DeleteProductConversionRequest,
  WaitTicket,
  WaitTicketHistory,
} from '@idosi/contracts';
import {
  ActiveWaitTicketExistsError,
  auditLogs,
  cancelWaitTicket as cancelDatabaseWaitTicket,
  closeDatabase,
  dailyPriorityOffers,
  declareStoreReceipt as declareDatabaseStoreReceipt,
  db,
  htkdAssignments,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  finalizeStoreReceipt as finalizeDatabaseStoreReceipt,
  getWaitTicketHistory as getDatabaseWaitTicketHistory,
  listPriorityOffers as listDatabasePriorityOffers,
  listWaitTickets as listDatabaseWaitTickets,
  loadMonthlyOperationalReport,
  orderRequestItems,
  orderRequests,
  orderSessions,
  OrderRequestAuthorizationError,
  OrderSessionUnavailableError,
  pool,
  productConversions,
  products,
  RequestLimitExceededError,
  respondPriorityOffer as respondDatabasePriorityOffer,
  sessions,
  StoreOperationConflictError,
  StoreOperationValidationError,
  StoreReceiptAuthorizationError,
  storeReceiptBags,
  storeReceiptLines,
  storeReceipts,
  storeGroups,
  storeInventoryBags,
  storeOutbounds,
  stores,
  submitOrderRequest as submitDatabaseOrderRequest,
  submitStoreReceipt as submitDatabaseStoreReceipt,
  users,
  returnStoreReceiptForCorrection as returnDatabaseStoreReceiptForCorrection,
  PriorityOfferConflictError,
  PriorityOfferNotFoundError,
  WaitTicketAuthorizationError,
  WaitTicketConflictError,
  WaitTicketNotFoundError,
  WaitTicketValidationError,
  withAdvisoryLock,
  withSerializableTransaction,
  type JsonObject,
  type MonthlyReportScope,
  type PriorityOfferRecord,
  type WaitTicketDatabaseStatus,
  type WaitTicketEffectiveStatus,
  type WaitTicketRecord,
} from '@idosi/database';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, type SQL } from 'drizzle-orm';

import { ApiError, conflict, forbidden, notFound, unauthenticated } from './errors.js';
import { monthlyOperationalReportDto } from './monthly-report.js';
import type {
  AccountCredentials,
  IdempotentResource,
  OrderStatistics,
  Page,
  RequestContext,
  SubmittedOrderRequest,
  WarehouseRepository,
} from './repository.js';
import { canAccessStore, pagination, slicePage } from './repository.js';
import { hashSessionToken } from './security.js';
import { asiaHoChiMinhDateRange } from './time.js';

export class PostgresWarehouseRepository implements WarehouseRepository {
  public async ready(): Promise<boolean> {
    try {
      await pool.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    await closeDatabase();
  }

  public async findCredentials(username: string): Promise<AccountCredentials | null> {
    const [account] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, username.trim()), isNull(users.deletedAt)))
      .limit(1);
    if (!account) return null;
    return this.credentialsFromRow(account);
  }

  public async createSession(
    account: AccountCredentials,
    token: string,
    expiresAt: Date,
    context: RequestContext,
  ): Promise<Session> {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [created] = await tx
        .insert(sessions)
        .values({
          userId: account.id,
          tokenHash: hashSessionToken(token),
          userTokenVersion: account.sessionVersion,
          expiresAt,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        })
        .returning();
      if (!created) throw new Error('Session insert did not return a row');
      await tx
        .update(users)
        .set({ lastLoginAt: now, updatedAt: now })
        .where(eq(users.id, account.id));
      return sessionDto(created, account);
    });
  }

  public async resolveSession(token: string): Promise<Session> {
    const tokenHash = hashSessionToken(token);
    const [row] = await db
      .select({ session: sessions, account: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(users.deletedAt)))
      .limit(1);
    if (!row || row.session.expiresAt.getTime() <= Date.now()) throw unauthenticated();
    if (
      row.session.revokedAt !== null ||
      row.account.tokenVersion !== row.session.userTokenVersion
    ) {
      throw new ApiError('SESSION_REVOKED', 'Phiên đăng nhập đã bị thu hồi', 401);
    }
    if (row.account.status !== 'active') {
      throw new ApiError('ACCOUNT_INACTIVE', 'Tài khoản đã bị khóa hoặc vô hiệu hóa', 403);
    }
    const credentials = await this.credentialsFromRow(row.account);
    const now = new Date();
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id));
    return sessionDto({ ...row.session, lastSeenAt: now }, credentials);
  }

  public async revokeSession(token: string, reason: string): Promise<boolean> {
    const revoked = await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return revoked.length > 0;
  }

  public async listOrderSessions(query: ListOrderSessionsQuery): Promise<Page<OrderSession>> {
    const predicates = [isNull(orderSessions.deletedAt)];
    if (query.status !== undefined) {
      predicates.push(eq(orderSessions.status, databaseOrderSessionStatus(query.status)));
    }
    if (query.dateFrom !== undefined) {
      predicates.push(gte(orderSessions.businessDate, query.dateFrom));
    }
    if (query.dateTo !== undefined) {
      predicates.push(lte(orderSessions.businessDate, query.dateTo));
    }
    const where = and(...predicates);
    const [totalRow] = await db.select({ value: count() }).from(orderSessions).where(where);
    const rows = await db
      .select()
      .from(orderSessions)
      .where(where)
      .orderBy(desc(orderSessions.businessDate), desc(orderSessions.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return {
      data: rows.map(orderSessionDto),
      pagination: pagination(query.page, query.pageSize, totalRow?.value ?? 0),
    };
  }

  public async listProducts(query: ListProductsQuery): Promise<Page<Product>> {
    const rows = await db
      .select()
      .from(products)
      .where(isNull(products.deletedAt))
      .orderBy(asc(products.displayOrder), asc(products.sku));
    const search = query.search?.toLocaleLowerCase('vi-VN');
    const values = rows
      .map(productDto)
      .filter((product) => query.status === undefined || product.status === query.status)
      .filter(
        (product) => query.measurement === undefined || product.measurement === query.measurement,
      )
      .filter(
        (product) =>
          search === undefined ||
          product.name.toLocaleLowerCase('vi-VN').includes(search) ||
          product.sku.toLocaleLowerCase('en-US').includes(search),
      );
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
    try {
      return await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(products)
          .values({
            sku: input.sku,
            slug: slugify(input.sku),
            name: input.name,
            unit: databaseUnit(input.measurement, input.unitLabel),
            isActive: true,
          })
          .returning();
        if (!created) throw new Error('Product insert did not return a row');
        const result = productDto(created);
        await tx
          .insert(auditLogs)
          .values(
            auditValue(
              actor,
              context,
              'PRODUCT_CREATED',
              'product',
              result.id,
              null,
              productJson(result),
            ),
          );
        return result;
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw conflict('Mã SKU đã tồn tại');
      throw error;
    }
  }

  public async updateProduct(
    actor: AuthenticatedPrincipal,
    productId: string,
    input: UpdateProductRequest,
    context: RequestContext,
  ): Promise<Product> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, productId), isNull(products.deletedAt)))
        .limit(1);
      if (!current) throw notFound('Không tìm thấy mặt hàng');
      const [updated] = await tx
        .update(products)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.status !== undefined ? { isActive: input.status === 'ACTIVE' } : {}),
          ...(input.unitLabel !== undefined
            ? { unit: databaseUnit(productDto(current).measurement, input.unitLabel) }
            : {}),
          updatedAt: new Date(),
          version: current.version + 1,
        })
        .where(eq(products.id, productId))
        .returning();
      if (!updated) throw new Error('Product update did not return a row');
      const beforeDto = productDto(current);
      const result = productDto(updated);
      await tx
        .insert(auditLogs)
        .values(
          auditValue(
            actor,
            context,
            'PRODUCT_UPDATED',
            'product',
            productId,
            productJson(beforeDto),
            productJson(result),
          ),
        );
      return result;
    });
  }

  public async listProductConversions(
    productId: string,
    query: ListProductConversionsQuery,
  ): Promise<Page<ProductConversion>> {
    await this.requireProduct(productId);
    const rows = await db
      .select()
      .from(productConversions)
      .where(eq(productConversions.productId, productId))
      .orderBy(asc(productConversions.version));
    const values = rows
      .map(conversionDto)
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
    const rows = await db
      .select()
      .from(productConversions)
      .orderBy(asc(productConversions.productId), asc(productConversions.version));
    const values = rows
      .map(conversionDto)
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
    return withSerializableTransaction(db, (tx) =>
      withAdvisoryLock(tx, 'product-conversion', productId, async () => {
        const [product] = await tx
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.id, productId), isNull(products.deletedAt)))
          .limit(1);
        if (!product) throw notFound('Không tìm thấy mặt hàng');
        const [existing] = await tx
          .select({ id: productConversions.id })
          .from(productConversions)
          .where(eq(productConversions.productId, productId))
          .limit(1);
        if (existing) {
          throw conflict('Mặt hàng đã có lịch sử quy đổi; hãy tạo phiên bản kế tiếp bằng PATCH');
        }
        const [created] = await tx
          .insert(productConversions)
          .values({
            productId,
            version: 1,
            itemQuantity: input.itemQuantity,
            weightKilograms: input.weightKilograms,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo,
            reason: input.reason,
            createdByUserId: actor.accountId,
          })
          .returning();
        if (!created) throw new Error('Product conversion insert did not return a row');
        const result = conversionDto(created);
        await tx
          .insert(auditLogs)
          .values(
            auditValue(
              actor,
              context,
              'PRODUCT_CONVERSION_CREATED',
              'product_conversion',
              result.id,
              null,
              conversionJson(result),
            ),
          );
        return result;
      }),
    );
  }

  public async replaceProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    conversionId: string,
    input: UpdateProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion> {
    return withSerializableTransaction(db, (tx) =>
      withAdvisoryLock(tx, 'product-conversion', productId, async () => {
        const [current] = await tx
          .select()
          .from(productConversions)
          .where(
            and(
              eq(productConversions.id, conversionId),
              eq(productConversions.productId, productId),
            ),
          )
          .limit(1);
        if (!current) throw notFound('Không tìm thấy tỷ lệ quy đổi');
        if (current.version !== input.expectedVersion) {
          throw new ApiError('VERSION_CONFLICT', 'Phiên bản tỷ lệ quy đổi đã thay đổi', 409);
        }
        if (current.retiredAt !== null) {
          throw conflict('Tỷ lệ quy đổi đã được thay thế hoặc ngừng dùng');
        }
        if (input.effectiveFrom <= current.effectiveFrom) {
          throw new ApiError(
            'VALIDATION_ERROR',
            'Ngày hiệu lực của phiên bản mới phải sau phiên bản hiện tại',
            400,
          );
        }
        const retiredAt = new Date();
        await tx
          .update(productConversions)
          .set({
            effectiveTo: input.effectiveFrom,
            retiredAt,
            retiredByUserId: actor.accountId,
            retirementReason: input.reason,
          })
          .where(eq(productConversions.id, current.id));
        const [created] = await tx
          .insert(productConversions)
          .values({
            productId,
            version: current.version + 1,
            itemQuantity: input.itemQuantity,
            weightKilograms: input.weightKilograms,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo,
            reason: input.reason,
            createdByUserId: actor.accountId,
          })
          .returning();
        if (!created) throw new Error('Replacement conversion insert did not return a row');
        const result = conversionDto(created);
        await tx
          .insert(auditLogs)
          .values(
            auditValue(
              actor,
              context,
              'PRODUCT_CONVERSION_REPLACED',
              'product_conversion',
              result.id,
              conversionJson(conversionDto(current)),
              conversionJson(result),
            ),
          );
        return result;
      }),
    );
  }

  public async retireProductConversion(
    actor: AuthenticatedPrincipal,
    productId: string,
    conversionId: string,
    input: DeleteProductConversionRequest,
    context: RequestContext,
  ): Promise<ProductConversion> {
    return withSerializableTransaction(db, (tx) =>
      withAdvisoryLock(tx, 'product-conversion', productId, async () => {
        const [current] = await tx
          .select()
          .from(productConversions)
          .where(
            and(
              eq(productConversions.id, conversionId),
              eq(productConversions.productId, productId),
            ),
          )
          .limit(1);
        if (!current) throw notFound('Không tìm thấy tỷ lệ quy đổi');
        if (current.version !== input.expectedVersion) {
          throw new ApiError('VERSION_CONFLICT', 'Phiên bản tỷ lệ quy đổi đã thay đổi', 409);
        }
        if (current.retiredAt !== null) return conversionDto(current);
        const [updated] = await tx
          .update(productConversions)
          .set({
            effectiveTo: retirementDate(current.effectiveFrom, new Date()),
            retiredAt: new Date(),
            retiredByUserId: actor.accountId,
            retirementReason: input.reason,
          })
          .where(eq(productConversions.id, current.id))
          .returning();
        if (!updated) throw new Error('Product conversion retirement did not return a row');
        const result = conversionDto(updated);
        await tx
          .insert(auditLogs)
          .values(
            auditValue(
              actor,
              context,
              'PRODUCT_CONVERSION_RETIRED',
              'product_conversion',
              result.id,
              conversionJson(conversionDto(current)),
              conversionJson(result),
            ),
          );
        return result;
      }),
    );
  }

  public async listStores(
    actor: AuthenticatedPrincipal,
    query: ListStoresQuery,
  ): Promise<Page<Store>> {
    const rows = await db
      .select()
      .from(stores)
      .where(isNull(stores.deletedAt))
      .orderBy(asc(stores.displayOrder), asc(stores.code));
    const search = query.search?.toLocaleLowerCase('vi-VN');
    const values = rows
      .map(storeDto)
      .filter((store) => canAccessStore(actor, store.id))
      .filter((store) => query.status === undefined || store.status === query.status)
      .filter((store) => query.kind === undefined || store.kind === query.kind)
      .filter((store) => query.groupId === undefined || store.groupId === query.groupId)
      .filter(
        (store) =>
          search === undefined ||
          store.name.toLocaleLowerCase('vi-VN').includes(search) ||
          store.code.toLocaleLowerCase('en-US').includes(search),
      );
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
    if (input.groupId === null) {
      throw new ApiError('VALIDATION_ERROR', 'Cửa hàng phải thuộc một nhóm', 400, {
        field: 'groupId',
      });
    }
    try {
      return await db.transaction(async (tx) => {
        const [group] = await tx
          .select({ id: storeGroups.id })
          .from(storeGroups)
          .where(and(eq(storeGroups.id, input.groupId as string), eq(storeGroups.isActive, true)))
          .limit(1);
        if (!group) throw notFound('Không tìm thấy nhóm cửa hàng hoạt động');
        const [created] = await tx
          .insert(stores)
          .values({
            code: input.code,
            name: input.name,
            groupId: group.id,
            kind: input.kind.toLocaleLowerCase('en-US') as 'retail' | 'wholesale',
            address: input.address,
            isActive: true,
          })
          .returning();
        if (!created) throw new Error('Store insert did not return a row');
        const result = storeDto(created);
        await tx
          .insert(auditLogs)
          .values(
            auditValue(
              actor,
              context,
              'STORE_CREATED',
              'store',
              result.id,
              null,
              storeJson(result),
            ),
          );
        return result;
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw conflict('Mã cửa hàng đã tồn tại');
      throw error;
    }
  }

  public async listOrderRequests(
    actor: AuthenticatedPrincipal,
    query: ListStoreOrderRequestsQuery,
  ): Promise<Page<StoreOrderRequest>> {
    if (query.storeId !== undefined && !canAccessStore(actor, query.storeId)) throw forbidden();
    const rows = await db
      .select()
      .from(orderRequests)
      .where(isNull(orderRequests.deletedAt))
      .orderBy(asc(orderRequests.createdAt));
    const filtered = rows.filter(
      (row) =>
        canAccessStore(actor, row.storeId) &&
        (query.storeId === undefined || row.storeId === query.storeId) &&
        (query.sessionId === undefined || row.orderSessionId === query.sessionId) &&
        (query.status === undefined || orderStatus(row.status) === query.status),
    );
    const selected = slicePage(filtered, query.page, query.pageSize);
    const data = await Promise.all(selected.map((row) => this.requestDto(row.id)));
    return {
      data,
      pagination: pagination(query.page, query.pageSize, filtered.length),
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
    try {
      const result = await submitDatabaseOrderRequest(db, {
        orderSessionId: input.businessSessionId,
        storeId: input.storeId,
        requestedByUserId: actor.accountId,
        items: input.items,
        idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
        requestHash,
        onCreated: async (tx, created) => {
          const requestForAudit: StoreOrderRequest = {
            id: created.id,
            sessionId: input.businessSessionId,
            storeId: input.storeId,
            requestSequence: created.requestNumber === 2 ? 2 : 1,
            status: 'SUBMITTED',
            lines: input.items.map((item) => ({
              productId: item.productId,
              requested: { kind: 'UNIT', quantity: item.quantity },
              priority: 'P1',
            })),
            submittedByAccountId: actor.accountId,
            submittedAt: created.submittedAt.toISOString(),
            cancelledAt: null,
          };
          await tx
            .insert(auditLogs)
            .values(
              auditValue(
                actor,
                context,
                'ORDER_REQUEST_SUBMITTED',
                'order_request',
                created.id,
                null,
                requestJson(requestForAudit),
              ),
            );
        },
      });
      const resourceId = result.replayed ? result.resourceId : result.value.id;
      if (!resourceId) throw new Error('Idempotent order response has no resource id');
      const data = await this.requestDto(resourceId);
      return { data, replayed: result.replayed };
    } catch (error: unknown) {
      if (error instanceof RequestLimitExceededError) {
        throw new ApiError(
          'REQUEST_LIMIT_REACHED',
          'Mỗi cửa hàng chỉ được gửi tối đa hai yêu cầu trong một phiên',
          409,
        );
      }
      if (error instanceof OrderRequestAuthorizationError) throw forbidden();
      if (error instanceof OrderSessionUnavailableError) {
        throw new ApiError('SESSION_NOT_OPEN', 'Phiên đặt hàng chưa mở hoặc đã đóng', 409);
      }
      if (error instanceof IdempotencyConflictError) {
        throw new ApiError(
          'IDEMPOTENCY_CONFLICT',
          'Khóa idempotency đã được dùng cho nội dung khác',
          409,
        );
      }
      if (error instanceof IdempotencyInProgressError) {
        throw conflict('Yêu cầu cùng khóa idempotency đang được xử lý');
      }
      if (error instanceof ActiveWaitTicketExistsError) {
        throw conflict('Cửa hàng đã có yêu cầu chờ đang hoạt động cho mặt hàng này');
      }
      throw error;
    }
  }

  public async listReceipts(
    actor: AuthenticatedPrincipal,
    query: ListReceiptsQuery,
  ): Promise<Page<Receipt>> {
    if (query.storeId !== undefined && !canAccessStore(actor, query.storeId)) throw forbidden();
    if (actor.role === 'STORE' && actor.storeId === null) {
      return { data: [], pagination: pagination(query.page, query.pageSize, 0) };
    }
    if (actor.role === 'HTKD' && actor.assignedStoreIds.length === 0) {
      return { data: [], pagination: pagination(query.page, query.pageSize, 0) };
    }

    const conditions: SQL[] = [isNull(storeReceipts.deletedAt)];
    if (query.storeId !== undefined) {
      conditions.push(eq(storeReceipts.storeId, query.storeId));
    } else if (actor.role === 'STORE' && actor.storeId !== null) {
      conditions.push(eq(storeReceipts.storeId, actor.storeId));
    } else if (actor.role === 'HTKD') {
      conditions.push(inArray(storeReceipts.storeId, [...actor.assignedStoreIds]));
    }
    if (query.outboundRequestId !== undefined) {
      conditions.push(eq(storeReceipts.outboundRequestId, query.outboundRequestId));
    }
    if (query.status !== undefined) {
      conditions.push(eq(storeReceipts.status, databaseReceiptStatus(query.status)));
    }

    const where = and(...conditions);
    const [totalRow] = await db.select({ value: count() }).from(storeReceipts).where(where);
    const rows = await db
      .select({ id: storeReceipts.id })
      .from(storeReceipts)
      .where(where)
      .orderBy(desc(storeReceipts.createdAt), desc(storeReceipts.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return {
      data: await Promise.all(rows.map((row) => this.receiptDto(row.id))),
      pagination: pagination(query.page, query.pageSize, totalRow?.value ?? 0),
    };
  }

  public async getReceipt(actor: AuthenticatedPrincipal, receiptId: string): Promise<Receipt> {
    const receipt = await this.receiptDto(receiptId);
    if (!canAccessStore(actor, receipt.storeId)) throw forbidden();
    return receipt;
  }

  public async declareStoreReceipt(
    actor: AuthenticatedPrincipal,
    input: DeclareStoreReceiptRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<Receipt>> {
    if (actor.role !== 'STORE' || actor.storeId !== input.storeId) throw forbidden();
    try {
      const result = await declareDatabaseStoreReceipt(db, {
        outboundRequestId: input.outboundRequestId,
        storeId: input.storeId,
        declaredByUserId: actor.accountId,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          approvedQuantity: line.approvedUnits,
          receivedQuantity: line.receivedUnits,
        })),
        discrepancyNote: input.discrepancyNote,
        requestId: context.requestId,
        idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
        requestHash,
      });
      const resourceId = result.replayed ? result.resourceId : result.value.receiptId;
      if (!resourceId) throw new Error('Idempotent receipt declaration has no resource id');
      return { data: await this.receiptDto(resourceId), replayed: result.replayed };
    } catch (error: unknown) {
      throwReceiptError(error);
    }
  }

  public async submitStoreReceipt(
    actor: AuthenticatedPrincipal,
    receiptId: string,
    input: SubmitStoreReceiptRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<Receipt>> {
    const current = await this.getReceipt(actor, receiptId);
    if (actor.role !== 'STORE' || actor.storeId !== current.storeId) throw forbidden();
    try {
      const result = await submitDatabaseStoreReceipt(db, {
        receiptId,
        expectedVersion: input.expectedVersion,
        submittedByUserId: actor.accountId,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          approvedQuantity: line.approvedUnits,
          receivedQuantity: line.receivedUnits,
        })),
        discrepancyNote: input.discrepancyNote,
        requestId: context.requestId,
        idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
        requestHash,
      });
      const resourceId = result.replayed ? result.resourceId : result.value.receiptId;
      if (!resourceId) throw new Error('Idempotent receipt submission has no resource id');
      return { data: await this.receiptDto(resourceId), replayed: result.replayed };
    } catch (error: unknown) {
      throwReceiptError(error);
    }
  }

  public async returnStoreReceiptForCorrection(
    actor: AuthenticatedPrincipal,
    receiptId: string,
    input: ReturnReceiptForCorrectionRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<Receipt>> {
    const current = await this.getReceipt(actor, receiptId);
    if (actor.role === 'STORE' || !canAccessStore(actor, current.storeId)) throw forbidden();
    try {
      const result = await returnDatabaseStoreReceiptForCorrection(db, {
        receiptId,
        expectedVersion: input.expectedVersion,
        reviewedByUserId: actor.accountId,
        reason: input.reason,
        requestId: context.requestId,
        idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
        requestHash,
      });
      const resourceId = result.replayed ? result.resourceId : result.value.receiptId;
      if (!resourceId) throw new Error('Idempotent receipt return has no resource id');
      return { data: await this.receiptDto(resourceId), replayed: result.replayed };
    } catch (error: unknown) {
      throwReceiptError(error);
    }
  }

  public async finalizeStoreReceipt(
    actor: AuthenticatedPrincipal,
    receiptId: string,
    input: FinalizeReceiptRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<Receipt>> {
    const current = await this.getReceipt(actor, receiptId);
    if (actor.role === 'STORE' || !canAccessStore(actor, current.storeId)) throw forbidden();
    assertFinalizationMatchesDeclaration(current, input);
    try {
      const result = await finalizeDatabaseStoreReceipt(db, {
        receiptId,
        expectedVersion: input.expectedVersion,
        reviewedByUserId: actor.accountId,
        freightVnd: BigInt(input.freightVnd),
        handlingVnd: BigInt(input.handlingVnd),
        lines: input.lines.map((line) => ({
          productId: line.productId,
          pricePerKgVnd: line.pricePerKgVnd === null ? null : BigInt(line.pricePerKgVnd),
          bagWeightsKg: line.bagWeightsKg,
        })),
        requestId: context.requestId,
        idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
        requestHash,
      });
      const resourceId = result.replayed ? result.resourceId : result.value.receiptId;
      if (!resourceId) throw new Error('Idempotent receipt finalization has no resource id');
      return { data: await this.receiptDto(resourceId), replayed: result.replayed };
    } catch (error: unknown) {
      throwReceiptError(error);
    }
  }

  public async listWaitTickets(
    actor: AuthenticatedPrincipal,
    query: ListWaitTicketsQuery,
  ): Promise<Page<WaitTicket>> {
    return withWaitErrors(async () => {
      const status = databaseWaitTicketFilter(query.status);
      const result = await listDatabaseWaitTickets(db, {
        actorUserId: actor.accountId,
        page: query.page,
        pageSize: query.pageSize,
        ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
        ...(query.productId === undefined ? {} : { productId: query.productId }),
        ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
        ...(query.priority === undefined ? {} : { priorityLevel: query.priority }),
        ...status,
      });
      return {
        data: result.data.map(waitTicketDto),
        pagination: result.pagination,
      };
    });
  }

  public async getWaitTicketHistory(
    actor: AuthenticatedPrincipal,
    waitTicketId: string,
    limit: number,
  ): Promise<WaitTicketHistory> {
    return withWaitErrors(async () => {
      const history = await getDatabaseWaitTicketHistory(db, {
        actorUserId: actor.accountId,
        waitTicketId,
        limit,
      });
      return {
        ticket: waitTicketDto(history.ticket),
        offers: history.offers.map(priorityOfferDto),
        audit: history.audit.map((event) => ({
          id: event.id,
          requestId: event.requestId,
          actorAccountId: event.actorUserId,
          actorRole:
            event.actorRole === null
              ? null
              : (event.actorRole.toUpperCase() as AuthenticatedPrincipal['role']),
          actorStoreId: event.actorStoreId,
          action: event.action,
          entityType:
            event.entityType === 'priority_offer'
              ? ('PRIORITY_OFFER' as const)
              : ('WAIT_TICKET' as const),
          entityId: event.entityId,
          before: event.before,
          after: event.after,
          metadata: event.metadata,
          createdAt: event.createdAt.toISOString(),
        })),
      };
    });
  }

  public async cancelWaitTicket(
    actor: AuthenticatedPrincipal,
    waitTicketId: string,
    input: CancelWaitTicketRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<WaitTicket>> {
    return withWaitErrors(async () => {
      const result = await cancelDatabaseWaitTicket(db, {
        waitTicketId,
        actorUserId: actor.accountId,
        reason: input.reason,
        requestId: context.requestId,
        idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
        requestHash,
      });
      const resourceId = result.replayed ? result.resourceId : result.value.waitTicketId;
      if (!resourceId) throw new Error('Idempotent wait cancellation has no resource id');
      const history = await getDatabaseWaitTicketHistory(db, {
        actorUserId: actor.accountId,
        waitTicketId: resourceId,
        limit: 1,
      });
      return { data: waitTicketDto(history.ticket), replayed: result.replayed };
    });
  }

  public async listPriorityOffers(
    actor: AuthenticatedPrincipal,
    query: ListPriorityOffersQuery,
  ): Promise<Page<PriorityOffer>> {
    return withWaitErrors(async () => {
      const result = await listDatabasePriorityOffers(db, {
        actorUserId: actor.accountId,
        page: query.page,
        pageSize: query.pageSize,
        ...(query.waitTicketId === undefined ? {} : { waitTicketId: query.waitTicketId }),
        ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
        ...(query.status === undefined
          ? {}
          : { status: databasePriorityOfferStatus(query.status) }),
      });
      return {
        data: result.data.map(priorityOfferDto),
        pagination: result.pagination,
      };
    });
  }

  public async respondPriorityOffer(
    actor: AuthenticatedPrincipal,
    offerId: string,
    input: RespondPriorityOfferRequest,
    idempotencyKey: string,
    requestHash: string,
    context: RequestContext,
  ): Promise<IdempotentResource<PriorityOffer>> {
    if (actor.role !== 'STORE') throw forbidden();
    const response = databasePriorityOfferResponse(input);
    return withWaitErrors(async () => {
      const result = await respondDatabasePriorityOffer(db, {
        offerId,
        actorUserId: actor.accountId,
        ...response,
        requestId: context.requestId,
        idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
        requestHash,
      });
      const resourceId = result.replayed ? result.resourceId : result.value.offerId;
      if (!resourceId) throw new Error('Idempotent priority-offer response has no resource id');
      return {
        data: await this.priorityOfferDto(actor, resourceId),
        replayed: result.replayed,
      };
    });
  }

  public async getMonthlyOperationalReport(
    actor: AuthenticatedPrincipal,
    query: MonthlyOperationalReportQuery,
  ): Promise<MonthlyOperationalReport> {
    const scope = await this.authorizeMonthlyReportScope(actor, query);
    return monthlyOperationalReportDto(
      await loadMonthlyOperationalReport(db, {
        year: query.year,
        month: query.month,
        scope,
      }),
    );
  }

  public async getOrderStatistics(
    actor: AuthenticatedPrincipal,
    storeCode: string,
    from: string,
    to: string,
  ): Promise<OrderStatistics> {
    const [store] = await db
      .select({ id: stores.id, code: stores.code })
      .from(stores)
      .where(and(eq(stores.code, storeCode), isNull(stores.deletedAt)))
      .limit(1);
    if (!store) throw notFound('Không tìm thấy cửa hàng');
    if (!canAccessStore(actor, store.id)) throw forbidden('Không có quyền xem cửa hàng này');

    const { start, endExclusive } = asiaHoChiMinhDateRange(from, to);
    const rows = await db
      .select({
        productId: products.id,
        sku: products.sku,
        name: products.name,
        revenueVnd: storeOutbounds.revenueVnd,
        weightKg: storeOutbounds.weightKg,
      })
      .from(storeOutbounds)
      .innerJoin(storeInventoryBags, eq(storeOutbounds.storeInventoryBagId, storeInventoryBags.id))
      .innerJoin(products, eq(storeInventoryBags.productId, products.id))
      .where(
        and(
          eq(storeOutbounds.storeId, store.id),
          eq(storeOutbounds.status, 'approved'),
          eq(storeOutbounds.reason, 'discount_sale'),
          gte(storeOutbounds.createdAt, start),
          lt(storeOutbounds.createdAt, endExclusive),
          isNull(storeOutbounds.deletedAt),
        ),
      );
    const grouped = new Map<
      string,
      { productId: string; sku: string; name: string; revenueVnd: bigint; weightGrams: bigint }
    >();
    for (const row of rows) {
      const current = grouped.get(row.productId) ?? {
        productId: row.productId,
        sku: row.sku,
        name: row.name,
        revenueVnd: 0n,
        weightGrams: 0n,
      };
      current.revenueVnd += row.revenueVnd ?? 0n;
      current.weightGrams += kilogramsToGrams(row.weightKg);
      grouped.set(row.productId, current);
    }
    const revenue = [...grouped.values()].reduce((sum, row) => sum + row.revenueVnd, 0n);
    const grams = [...grouped.values()].reduce((sum, row) => sum + row.weightGrams, 0n);
    return {
      storeCode,
      period: { from, to },
      totals: {
        revenueByType: { NORMAL: 0, SALE_KG: safeVnd(revenue), SALE_PIECE: 0 },
        revenue: safeVnd(revenue),
        weight: {
          actualKg: gramsToKilograms(grams),
          estimatedKg: '0.000',
          totalKg: gramsToKilograms(grams),
          isComplete: true,
        },
      },
      products: [...grouped.values()]
        .sort((left, right) => left.sku.localeCompare(right.sku))
        .map((row) => ({
          productId: row.productId,
          sku: row.sku,
          name: row.name,
          revenueVnd: safeVnd(row.revenueVnd),
          weightKg: gramsToKilograms(row.weightGrams),
        })),
      generatedAt: new Date().toISOString(),
    };
  }

  private async credentialsFromRow(
    account: typeof users.$inferSelect,
  ): Promise<AccountCredentials> {
    const assignedStoreIds =
      account.role === 'htkd'
        ? (
            await db
              .select({ storeId: htkdAssignments.storeId })
              .from(htkdAssignments)
              .where(and(eq(htkdAssignments.userId, account.id), isNull(htkdAssignments.revokedAt)))
          ).map((assignment) => assignment.storeId)
        : [];
    return {
      id: account.id,
      username: account.email,
      displayName: account.displayName,
      role: account.role.toUpperCase() as AccountCredentials['role'],
      status: account.status.toUpperCase() as AccountCredentials['status'],
      storeId: account.storeId,
      passwordHash: account.passwordHash,
      sessionVersion: account.tokenVersion,
      assignedStoreIds,
    };
  }

  private async requireProduct(productId: string): Promise<void> {
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.deletedAt)))
      .limit(1);
    if (!product) throw notFound('Không tìm thấy mặt hàng');
  }

  private async requestDto(requestId: string): Promise<StoreOrderRequest> {
    const [request] = await db
      .select()
      .from(orderRequests)
      .where(and(eq(orderRequests.id, requestId), isNull(orderRequests.deletedAt)))
      .limit(1);
    if (!request) throw notFound('Không tìm thấy yêu cầu đặt hàng');
    const items = await db
      .select()
      .from(orderRequestItems)
      .where(eq(orderRequestItems.orderRequestId, request.id));
    return {
      id: request.id,
      sessionId: request.orderSessionId,
      storeId: request.storeId,
      requestSequence: request.requestNumber === 2 ? 2 : 1,
      status: orderStatus(request.status),
      lines: items.map((item) => ({
        productId: item.productId,
        requested: { kind: 'UNIT', quantity: item.requestedQuantity },
        priority: item.priorityLevel === 'P0A' ? 'P0B' : item.priorityLevel,
        ...(item.notes ? { note: item.notes } : {}),
      })),
      submittedByAccountId: request.requestedByUserId,
      submittedAt: (request.submittedAt ?? request.createdAt).toISOString(),
      cancelledAt: request.cancelledAt?.toISOString() ?? null,
    };
  }

  private async receiptDto(receiptId: string): Promise<Receipt> {
    const [receipt] = await db
      .select()
      .from(storeReceipts)
      .where(and(eq(storeReceipts.id, receiptId), isNull(storeReceipts.deletedAt)))
      .limit(1);
    if (!receipt) throw notFound('Không tìm thấy phiếu nhận hàng');

    const lines = await db
      .select()
      .from(storeReceiptLines)
      .where(eq(storeReceiptLines.storeReceiptId, receipt.id))
      .orderBy(asc(storeReceiptLines.productId));
    if (lines.length === 0) throw new Error('Store receipt has no product lines');
    const bags = await db
      .select()
      .from(storeReceiptBags)
      .where(
        inArray(
          storeReceiptBags.storeReceiptLineId,
          lines.map((line) => line.id),
        ),
      )
      .orderBy(asc(storeReceiptBags.storeReceiptLineId), asc(storeReceiptBags.bagNumber));
    const weightsByLine = new Map<string, string[]>();
    for (const bag of bags) {
      const weights = weightsByLine.get(bag.storeReceiptLineId) ?? [];
      weights.push(bag.weightKg);
      weightsByLine.set(bag.storeReceiptLineId, weights);
    }

    return {
      id: receipt.id,
      receiptNumber: receipt.receiptNumber,
      storeId: receipt.storeId,
      outboundRequestId: receipt.outboundRequestId,
      declaredByAccountId: receipt.declaredByUserId,
      lines: lines.map((line) => ({
        productId: line.productId,
        approvedUnits: line.approvedQuantity,
        receivedUnits: line.receivedQuantity,
        bagWeightsKg: weightsByLine.get(line.id) ?? [],
        pricePerKgVnd: line.pricePerKgVnd === null ? null : safeVnd(line.pricePerKgVnd),
      })),
      discrepancyNote: receipt.discrepancyNote,
      status: receiptStatus(receipt.status),
      freightVnd: safeVnd(receipt.freightVnd),
      handlingVnd: safeVnd(receipt.handlingVnd),
      totalCostVnd: receipt.status === 'finalized' ? safeVnd(receipt.totalCostVnd) : null,
      reviewedByAccountId: receipt.reviewedByUserId,
      reviewNote: receipt.reviewNote,
      version: receipt.version,
      createdAt: receipt.createdAt.toISOString(),
      updatedAt: receipt.updatedAt.toISOString(),
    };
  }

  private async priorityOfferDto(
    actor: AuthenticatedPrincipal,
    offerId: string,
  ): Promise<PriorityOffer> {
    const [offer] = await db
      .select()
      .from(dailyPriorityOffers)
      .where(and(eq(dailyPriorityOffers.id, offerId), isNull(dailyPriorityOffers.deletedAt)))
      .limit(1);
    if (!offer) throw notFound('Không tìm thấy đề nghị ưu tiên');
    if (!canAccessStore(actor, offer.storeId)) throw forbidden();
    const effectiveStatus =
      offer.status === 'offered' && offer.responseDeadlineAt.getTime() <= Date.now()
        ? 'expired'
        : offer.status;
    return priorityOfferDto({ ...offer, effectiveStatus });
  }

  private async authorizeMonthlyReportScope(
    actor: AuthenticatedPrincipal,
    query: MonthlyOperationalReportQuery,
  ): Promise<MonthlyReportScope> {
    if (query.scopeKind === 'ALL') {
      if (actor.role !== 'ADMIN') throw forbidden();
      return { kind: 'ALL' };
    }
    if (!query.scopeId) {
      throw new ApiError('VALIDATION_ERROR', 'Phạm vi báo cáo thiếu mã định danh', 400);
    }
    if (query.scopeKind === 'GROUP') {
      if (actor.role !== 'ADMIN') throw forbidden();
      const [group] = await db
        .select({ id: storeGroups.id })
        .from(storeGroups)
        .where(and(eq(storeGroups.id, query.scopeId), eq(storeGroups.isActive, true)))
        .limit(1);
      if (!group) throw notFound('Không tìm thấy nhóm cửa hàng');
      return { kind: 'GROUP', id: group.id };
    }
    if (!canAccessStore(actor, query.scopeId)) throw forbidden();
    const [store] = await db
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.id, query.scopeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
      .limit(1);
    if (!store) throw notFound('Không tìm thấy cửa hàng');
    return { kind: 'STORE', id: store.id };
  }
}

function sessionDto(stored: typeof sessions.$inferSelect, account: AccountCredentials): Session {
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

function productDto(row: typeof products.$inferSelect): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    measurement: row.unit === 'kilogram' ? 'WEIGHT' : 'UNIT',
    unitLabel: row.unit === 'kilogram' ? 'kg' : row.unit === 'item' ? 'cái' : 'bao',
    status: row.isActive ? 'ACTIVE' : 'INACTIVE',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function storeDto(row: typeof stores.$inferSelect): Store {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    groupId: row.groupId,
    kind: row.kind === 'wholesale' ? 'WHOLESALE' : 'RETAIL',
    status: row.isActive ? 'ACTIVE' : 'INACTIVE',
    address: row.address,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function conversionDto(row: typeof productConversions.$inferSelect): ProductConversion {
  return {
    id: row.id,
    productId: row.productId,
    version: row.version,
    itemQuantity: row.itemQuantity,
    weightKilograms: row.weightKilograms,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    reason: row.reason,
    createdByAccountId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
    retiredByAccountId: row.retiredByUserId,
    retirementReason: row.retirementReason,
  };
}

function databaseUnit(
  measurement: CreateProductRequest['measurement'],
  unitLabel: string,
): 'item' | 'bag' | 'kilogram' {
  if (measurement === 'WEIGHT') return 'kilogram';
  return /^(cái|item|piece)$/iu.test(unitLabel.trim()) ? 'item' : 'bag';
}

function orderStatus(
  status: typeof orderRequests.$inferSelect.status,
): StoreOrderRequest['status'] {
  if (status === 'cancelled') return 'CANCELLED';
  if (status === 'draft' || status === 'submitted') return 'SUBMITTED';
  return 'MERGED';
}

function databaseOrderSessionStatus(
  status: OrderSession['status'],
): typeof orderSessions.$inferSelect.status {
  switch (status) {
    case 'SCHEDULED':
      return 'draft';
    case 'OPEN':
      return 'open';
    case 'CLOSED':
      return 'closed';
    case 'ALLOCATING':
      return 'allocating';
    case 'ALLOCATED':
      return 'completed';
    case 'CANCELLED':
      return 'cancelled';
  }
}

function orderSessionStatus(
  status: typeof orderSessions.$inferSelect.status,
): OrderSession['status'] {
  switch (status) {
    case 'draft':
      return 'SCHEDULED';
    case 'open':
      return 'OPEN';
    case 'closed':
      return 'CLOSED';
    case 'allocating':
      return 'ALLOCATING';
    case 'completed':
      return 'ALLOCATED';
    case 'cancelled':
      return 'CANCELLED';
  }
}

function orderSessionDto(row: typeof orderSessions.$inferSelect): OrderSession {
  return {
    id: row.id,
    businessDate: row.businessDate,
    status: orderSessionStatus(row.status),
    requestOpensAt: (row.openedAt ?? row.createdAt).toISOString(),
    requestClosesAt: row.inventorySnapshotDueAt.toISOString(),
    allocationStartsAt: row.requestDeadlineAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function databaseReceiptStatus(
  status: Receipt['status'],
): typeof storeReceipts.$inferSelect.status {
  switch (status) {
    case 'DRAFT':
      return 'draft';
    case 'PENDING_HTKD':
      return 'pending_htkd';
    case 'RETURNED':
      return 'returned';
    case 'FINALIZED':
      return 'finalized';
  }
}

function receiptStatus(status: typeof storeReceipts.$inferSelect.status): Receipt['status'] {
  switch (status) {
    case 'draft':
      return 'DRAFT';
    case 'pending_htkd':
      return 'PENDING_HTKD';
    case 'returned':
      return 'RETURNED';
    case 'finalized':
      return 'FINALIZED';
  }
}

function waitTicketDto(ticket: WaitTicketRecord): WaitTicket {
  return {
    id: ticket.id,
    sessionId: ticket.orderSessionId,
    mergedOrderId: ticket.mergedOrderId,
    storeId: ticket.storeId,
    productId: ticket.productId,
    priority: ticket.priorityLevel,
    requested: { kind: 'UNIT', quantity: ticket.originalQuantity },
    fulfilled: { kind: 'UNIT', quantity: ticket.fulfilledQuantity },
    remaining: { kind: 'UNIT', quantity: ticket.remainingQuantity },
    status:
      ticket.status === 'active'
        ? ticket.hasOpenOffer
          ? 'OFFERED'
          : ticket.fulfilledQuantity > 0
            ? 'PARTIALLY_FULFILLED'
            : 'WAITING'
        : (ticket.status.toUpperCase() as WaitTicket['status']),
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

function priorityOfferDto(offer: PriorityOfferRecord): PriorityOffer {
  const status = offer.effectiveStatus.toUpperCase() as PriorityOffer['status'];
  return {
    id: offer.id,
    waitTicketId: offer.waitTicketId,
    storeId: offer.storeId,
    productId: offer.productId,
    offered: { kind: 'UNIT', quantity: offer.offeredQuantity },
    status,
    offeredAt: offer.createdAt.toISOString(),
    expiresAt: offer.responseDeadlineAt.toISOString(),
    respondedAt: offer.respondedAt?.toISOString() ?? null,
    accepted: status === 'ACCEPTED' ? { kind: 'UNIT', quantity: offer.acceptedQuantity } : null,
  };
}

function databaseWaitTicketFilter(status: WaitTicket['status'] | undefined): {
  readonly status?: WaitTicketDatabaseStatus;
  readonly effectiveStatus?: WaitTicketEffectiveStatus;
} {
  switch (status) {
    case undefined:
      return {};
    case 'WAITING':
      return { effectiveStatus: 'waiting' };
    case 'OFFERED':
      return { effectiveStatus: 'offered' };
    case 'PARTIALLY_FULFILLED':
      return { effectiveStatus: 'partially_fulfilled' };
    case 'FULFILLED':
      return { status: 'fulfilled' };
    case 'CANCELLED':
      return { status: 'cancelled' };
    case 'EXPIRED':
      return { status: 'expired' };
  }
}

function databasePriorityOfferStatus(
  status: PriorityOffer['status'],
): PriorityOfferRecord['status'] {
  switch (status) {
    case 'PENDING':
      return 'offered';
    case 'ACCEPTED':
      return 'accepted';
    case 'DECLINED':
      return 'declined';
    case 'EXPIRED':
      return 'expired';
    case 'CANCELLED':
      return 'cancelled';
  }
}

function databasePriorityOfferResponse(
  input: RespondPriorityOfferRequest,
):
  | { readonly action: 'accept'; readonly acceptedQuantity: number }
  | { readonly action: 'decline'; readonly reason?: string } {
  if (input.action === 'ACCEPT') {
    if (input.accepted.kind !== 'UNIT') {
      throw new ApiError('VALIDATION_ERROR', 'Đề nghị ưu tiên chỉ hỗ trợ số lượng đơn vị', 400);
    }
    return { action: 'accept', acceptedQuantity: input.accepted.quantity };
  }
  return {
    action: 'decline',
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

async function withWaitErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof WaitTicketAuthorizationError) throw forbidden();
    if (error instanceof WaitTicketNotFoundError) throw notFound('Không tìm thấy phiếu chờ');
    if (error instanceof PriorityOfferNotFoundError) {
      throw notFound('Không tìm thấy đề nghị ưu tiên');
    }
    if (error instanceof WaitTicketValidationError) {
      throw new ApiError('VALIDATION_ERROR', error.message, 400);
    }
    if (error instanceof WaitTicketConflictError || error instanceof PriorityOfferConflictError) {
      throw conflict(error.message);
    }
    if (error instanceof IdempotencyConflictError) {
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'Khóa idempotency đã được dùng cho nội dung khác',
        409,
      );
    }
    if (error instanceof IdempotencyInProgressError) {
      throw conflict('Yêu cầu cùng khóa idempotency đang được xử lý');
    }
    throw error;
  }
}

function assertFinalizationMatchesDeclaration(
  current: Receipt,
  input: FinalizeReceiptRequest,
): void {
  const declaredByProduct = new Map(current.lines.map((line) => [line.productId, line]));
  if (declaredByProduct.size !== input.lines.length) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Các dòng xác nhận phải khớp chính xác với khai báo đã gửi',
      400,
    );
  }
  for (const line of input.lines) {
    const declared = declaredByProduct.get(line.productId);
    if (
      !declared ||
      line.approvedUnits !== declared.approvedUnits ||
      line.receivedUnits !== declared.receivedUnits
    ) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'Số lượng xác nhận không được thay đổi khai báo đã gửi',
        400,
      );
    }
  }
}

function throwReceiptError(error: unknown): never {
  if (error instanceof StoreReceiptAuthorizationError) throw forbidden();
  if (error instanceof StoreOperationValidationError) {
    throw new ApiError('VALIDATION_ERROR', error.message, 400);
  }
  if (error instanceof StoreOperationConflictError) {
    throw new ApiError('VERSION_CONFLICT', 'Phiếu nhận hàng đã thay đổi hoặc sai trạng thái', 409);
  }
  if (error instanceof IdempotencyConflictError) {
    throw new ApiError(
      'IDEMPOTENCY_CONFLICT',
      'Khóa idempotency đã được dùng cho nội dung khác',
      409,
    );
  }
  if (error instanceof IdempotencyInProgressError) {
    throw conflict('Yêu cầu cùng khóa idempotency đang được xử lý');
  }
  throw error;
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug || `sku-${Date.now()}`;
}

function auditValue(
  actor: AuthenticatedPrincipal,
  context: RequestContext,
  action: string,
  entityType: string,
  entityId: string,
  before: JsonObject | null,
  after: JsonObject | null,
): typeof auditLogs.$inferInsert {
  return {
    requestId: context.requestId,
    actorUserId: actor.accountId,
    actorRole: actor.role.toLocaleLowerCase('en-US') as 'admin' | 'htkd' | 'store',
    actorStoreId: actor.storeId,
    action,
    entityType,
    entityId,
    before,
    after,
    metadata: {},
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  };
}

function productJson(product: Product): JsonObject {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    measurement: product.measurement,
    unitLabel: product.unitLabel,
    status: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

function storeJson(store: Store): JsonObject {
  return {
    id: store.id,
    code: store.code,
    name: store.name,
    groupId: store.groupId,
    kind: store.kind,
    status: store.status,
    address: store.address,
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
  };
}

function conversionJson(conversion: ProductConversion): JsonObject {
  return {
    id: conversion.id,
    productId: conversion.productId,
    version: conversion.version,
    itemQuantity: conversion.itemQuantity,
    weightKilograms: conversion.weightKilograms,
    effectiveFrom: conversion.effectiveFrom,
    effectiveTo: conversion.effectiveTo,
    reason: conversion.reason,
    createdByAccountId: conversion.createdByAccountId,
    createdAt: conversion.createdAt,
    retiredAt: conversion.retiredAt,
    retiredByAccountId: conversion.retiredByAccountId,
    retirementReason: conversion.retirementReason,
  };
}

function requestJson(request: StoreOrderRequest): JsonObject {
  return {
    id: request.id,
    sessionId: request.sessionId,
    storeId: request.storeId,
    requestSequence: request.requestSequence,
    status: request.status,
    submittedByAccountId: request.submittedByAccountId,
    submittedAt: request.submittedAt,
    cancelledAt: request.cancelledAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

function kilogramsToGrams(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, '0').slice(0, 3));
}

function gramsToKilograms(value: bigint): string {
  const whole = value / 1_000n;
  const fraction = (value % 1_000n).toString().padStart(3, '0');
  return `${whole}.${fraction}`;
}

function safeVnd(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new Error('Revenue exceeds safe VND response range');
  return converted;
}

function retirementDate(effectiveFrom: string, now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return today > effectiveFrom ? today : effectiveFrom;
}
