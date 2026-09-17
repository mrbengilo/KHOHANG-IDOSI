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
  ActiveWaitTicketExistsError,
  auditLogs,
  closeDatabase,
  db,
  htkdAssignments,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  orderRequestItems,
  orderRequests,
  orderSessions,
  OrderRequestAuthorizationError,
  OrderSessionUnavailableError,
  pool,
  productConversions,
  products,
  RequestLimitExceededError,
  sessions,
  storeGroups,
  storeInventoryBags,
  storeOutbounds,
  stores,
  submitOrderRequest as submitDatabaseOrderRequest,
  users,
  withAdvisoryLock,
  withSerializableTransaction,
  type JsonObject,
} from '@idosi/database';
import { and, asc, count, desc, eq, gte, isNull, lt, lte } from 'drizzle-orm';

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
