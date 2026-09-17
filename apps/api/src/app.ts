import { randomUUID } from 'node:crypto';

import {
  AccountParamsSchema,
  CancelInboundReceiptRequestSchema,
  CancelWaitTicketRequestSchema,
  CreateAccountRequestSchema,
  CreateInboundReceiptRequestSchema,
  CreateProductRequestSchema,
  CreateProductConversionRequestSchema,
  CreateStoreOrderRequestSchema,
  CreateStoreOutboundRequestSchema,
  CreateStoreRequestSchema,
  DeclareStoreReceiptRequestSchema,
  ConfirmReceiptCostsRequestSchema,
  FinalizeReceiptRequestSchema,
  GetOperationalSettingsQuerySchema,
  IdempotencyHeadersSchema,
  IsoDateSchema,
  InboundReceiptParamsSchema,
  ListOrderSessionsQuerySchema,
  ListAccountsQuerySchema,
  ListAuditLogsQuerySchema,
  ListInboundReceiptsQuerySchema,
  ListPriorityOffersQuerySchema,
  ListProductsQuerySchema,
  ListProductConversionsQuerySchema,
  ListReceiptsQuerySchema,
  ListStoreInventoryBagLedgerQuerySchema,
  ListStoreInventoryBagsQuerySchema,
  ListStoreOutboundsQuerySchema,
  ListStoreReceiptSourcesQuerySchema,
  ListStoreOrderRequestsQuerySchema,
  ListStoresQuerySchema,
  ListWaitTicketsQuerySchema,
  LoginRequestSchema,
  MonthlyOperationalReportQuerySchema,
  OpenStoreInventoryBagRequestSchema,
  ProductParamsSchema,
  ProductConversionParamsSchema,
  PriorityOfferParamsSchema,
  ReceiptParamsSchema,
  ResetPasswordRequestSchema,
  ReviewStoreOutboundRequestSchema,
  ReturnReceiptForCorrectionRequestSchema,
  RespondPriorityOfferRequestSchema,
  SubmitStoreReceiptRequestSchema,
  StoreInventoryBagParamsSchema,
  StoreOutboundParamsSchema,
  WaitTicketHistoryQuerySchema,
  WaitTicketParamsSchema,
  DeleteProductConversionRequestSchema,
  UpdateProductConversionRequestSchema,
  UpdateProductRequestSchema,
  UpdateAccountRequestSchema,
  ListStoreTransfersQuerySchema,
  CreateStoreTransferRequestSchema,
  DispatchStoreTransferRequestSchema,
  ReceiveStoreTransferRequestSchema,
  CancelStoreTransferRequestSchema,
  StoreTransferParamsSchema,
  UpdateOperationalSettingsRequestSchema,
  type ApiErrorCode,
  type AuthenticatedPrincipal,
  type Session,
} from '@idosi/contracts';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { z, ZodError } from 'zod';

import { ApiError, forbidden, unauthenticated } from './errors.js';
import { MemoryWarehouseRepository } from './memory-repository.js';
import { LoginRateLimiter, type LoginRateLimitOptions } from './rate-limit.js';
import type { AccountCredentials, RequestContext, WarehouseRepository } from './repository.js';
import {
  hashCanonicalRequest,
  hashPassword,
  newOpaqueSessionToken,
  verifyPassword,
} from './security.js';

const SESSION_COOKIE = 'idosi_session';
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DEFAULT_IDOSI_INTEGRATION_ENDPOINT =
  'https://idosi.io.vn/api/integrations/warehouse/v1/order-statistics';

const StatisticsQuerySchema = z
  .object({
    storeCode: z.string().trim().min(1).max(40),
    from: IsoDateSchema,
    to: IsoDateSchema,
  })
  .strict()
  .refine((query) => query.from <= query.to, {
    path: ['to'],
    message: 'Ngày kết thúc không được trước ngày bắt đầu',
  });

export interface CreateApiOptions {
  readonly repository?: WarehouseRepository;
  readonly sessionTtlMs?: number;
  readonly corsOrigin?: string | readonly string[];
  readonly secureCookies?: boolean;
  readonly logger?: boolean | { readonly level: string };
  readonly trustProxy?: FastifyServerOptions['trustProxy'];
  readonly loginRateLimit?: LoginRateLimitOptions;
  readonly idosiIntegrationEndpoint?: string;
  readonly idosiIntegrationSecretConfigured?: boolean;
}

export async function createApi(options: CreateApiOptions = {}): Promise<FastifyInstance> {
  const repository = options.repository ?? (await MemoryWarehouseRepository.create());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new Error('sessionTtlMs must be a positive safe integer');
  }
  const dummyPasswordHash = await hashPassword(randomUUID());
  const loginRateLimiter = new LoginRateLimiter(options.loginRateLimit);
  const idosiIntegration = integrationStatus(options);
  const fastifyOptions: FastifyServerOptions = {
    logger: options.logger ?? false,
    bodyLimit: 1_048_576,
    trustProxy: options.trustProxy ?? false,
    genReqId: (request) => {
      const candidate = request.headers['x-request-id'];
      return typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)
        ? candidate
        : randomUUID();
    },
  };
  const app = Fastify(fastifyOptions);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    applyCors(request, reply, options.corsOrigin);
    if (request.method === 'OPTIONS') return reply.status(204).send();
    if (
      request.headers.origin &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !isAllowedOrigin(request.headers.origin, options.corsOrigin)
    ) {
      throw forbidden('Nguồn yêu cầu không được phép');
    }
  });

  app.addHook('onClose', async () => repository.close());

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(errorEnvelope('NOT_FOUND', 'Không tìm thấy tài nguyên', request.id)),
  );
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Dữ liệu yêu cầu không hợp lệ',
          requestId: request.id,
          fieldErrors: zodFieldErrors(error),
        },
      });
    }
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      error.statusCode === 400
    ) {
      return reply
        .status(400)
        .send(errorEnvelope('VALIDATION_ERROR', 'Nội dung JSON không hợp lệ', request.id));
    }
    request.log.error({ err: error, requestId: request.id }, 'request failed');
    return reply
      .status(500)
      .send(errorEnvelope('INTERNAL_ERROR', 'Lỗi hệ thống ngoài dự kiến', request.id));
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    const ready = await repository.ready();
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });
  app.get('/openapi.json', async () => openApiDocument());

  app.post('/api/v1/auth/login', async (request, reply) => {
    const input = LoginRequestSchema.parse(request.body);
    const retryAfterMs = loginRateLimiter.retryAfterMs(request.ip);
    if (retryAfterMs > 0) {
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
      reply.header('retry-after', String(retryAfterSeconds));
      throw new ApiError(
        'RATE_LIMITED',
        'Quá nhiều lần đăng nhập không thành công. Vui lòng thử lại sau.',
        429,
        { retryAfterSeconds },
      );
    }
    const account = await repository.findCredentials(input.username);
    const passwordMatches = await verifyPassword(
      input.password,
      account?.passwordHash ?? dummyPasswordHash,
    );
    if (!account || !passwordMatches) {
      loginRateLimiter.recordFailure(request.ip);
      throw unauthenticated('Tên đăng nhập hoặc mật khẩu không đúng');
    }
    loginRateLimiter.reset(request.ip);
    assertActiveAccount(account);

    const token = newOpaqueSessionToken();
    const expiresAt = new Date(Date.now() + sessionTtlMs);
    const session = await repository.createSession(
      account,
      token,
      expiresAt,
      requestContext(request),
    );
    reply.header('set-cookie', sessionCookie(token, expiresAt, options.secureCookies ?? false));
    reply.header('cache-control', 'no-store');
    return { data: session };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await repository.revokeSession(token, 'user_logout');
    reply.header('set-cookie', clearSessionCookie(options.secureCookies ?? false));
    reply.header('cache-control', 'no-store');
    return { data: { revoked: true } };
  });

  app.get('/api/v1/auth/session', async (request, reply) => {
    const session = await authenticate(request, repository);
    reply.header('cache-control', 'no-store');
    return { data: session };
  });

  app.get('/api/v1/admin/accounts', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN']);
    const query = ListAccountsQuerySchema.parse(request.query);
    reply.header('cache-control', 'no-store');
    return repository.listAccounts(session.principal, query);
  });

  app.post('/api/v1/admin/accounts', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN']);
    const input = CreateAccountRequestSchema.parse(request.body);
    const account = await repository.createAccount(
      session.principal,
      input,
      requestContext(request),
    );
    reply.header('cache-control', 'no-store');
    return reply.status(201).send({ data: account });
  });

  app.patch('/api/v1/admin/accounts/:accountId', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN']);
    const { accountId } = AccountParamsSchema.parse(request.params);
    const input = UpdateAccountRequestSchema.parse(request.body);
    const account = await repository.updateAccount(
      session.principal,
      accountId,
      input,
      requestContext(request),
    );
    reply.header('cache-control', 'no-store');
    return { data: account };
  });

  app.post('/api/v1/admin/accounts/:accountId/reset-password', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN']);
    const { accountId } = AccountParamsSchema.parse(request.params);
    const input = ResetPasswordRequestSchema.parse(request.body);
    const result = await repository.resetAccountPassword(
      session.principal,
      accountId,
      input,
      requestContext(request),
    );
    reply.header('cache-control', 'no-store');
    return { data: result };
  });

  app.get('/api/v1/admin/audit-logs', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN']);
    const query = ListAuditLogsQuerySchema.parse(request.query);
    reply.header('cache-control', 'no-store');
    return repository.listAuditLogs(session.principal, query);
  });

  app.get('/api/v1/admin/operational-settings', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN']);
    const query = GetOperationalSettingsQuerySchema.parse(request.query);
    const settings = await repository.getOperationalSettings(session.principal, query.historyLimit);
    reply.header('cache-control', 'no-store');
    return { data: { ...settings, integration: idosiIntegration } };
  });

  app.put('/api/v1/admin/operational-settings', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN']);
    const input = UpdateOperationalSettingsRequestSchema.parse(request.body);
    await repository.updateOperationalSettings(session.principal, input, requestContext(request));
    const settings = await repository.getOperationalSettings(session.principal, 10);
    reply.header('cache-control', 'no-store');
    return { data: { ...settings, integration: idosiIntegration } };
  });

  app.get('/api/v1/products', async (request) => {
    await authenticate(request, repository);
    const query = ListProductsQuerySchema.parse(request.query);
    return repository.listProducts(query);
  });

  app.get('/api/v1/order-sessions', async (request) => {
    await authenticate(request, repository);
    const query = ListOrderSessionsQuerySchema.parse(request.query);
    return repository.listOrderSessions(query);
  });

  app.post('/api/v1/products', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const input = CreateProductRequestSchema.parse(request.body);
    const product = await repository.createProduct(
      session.principal,
      input,
      requestContext(request),
    );
    return reply.status(201).send({ data: product });
  });

  app.patch('/api/v1/products/:productId', async (request) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const { productId } = ProductParamsSchema.parse(request.params);
    const input = UpdateProductRequestSchema.parse(request.body);
    return {
      data: await repository.updateProduct(
        session.principal,
        productId,
        input,
        requestContext(request),
      ),
    };
  });

  app.get('/api/v1/product-conversions', async (request) => {
    await authenticate(request, repository);
    const query = ListProductConversionsQuerySchema.parse(request.query);
    return repository.listAllProductConversions(query);
  });

  app.get('/api/v1/products/:productId/conversions', async (request) => {
    await authenticate(request, repository);
    const { productId } = ProductParamsSchema.parse(request.params);
    const query = ListProductConversionsQuerySchema.parse(request.query);
    return repository.listProductConversions(productId, query);
  });

  app.post('/api/v1/products/:productId/conversions', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const { productId } = ProductParamsSchema.parse(request.params);
    const input = CreateProductConversionRequestSchema.parse(request.body);
    const conversion = await repository.createProductConversion(
      session.principal,
      productId,
      input,
      requestContext(request),
    );
    return reply.status(201).send({ data: conversion });
  });

  app.patch('/api/v1/products/:productId/conversions/:conversionId', async (request) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const { productId, conversionId } = ProductConversionParamsSchema.parse(request.params);
    const input = UpdateProductConversionRequestSchema.parse(request.body);
    return {
      data: await repository.replaceProductConversion(
        session.principal,
        productId,
        conversionId,
        input,
        requestContext(request),
      ),
    };
  });

  app.delete('/api/v1/products/:productId/conversions/:conversionId', async (request) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const { productId, conversionId } = ProductConversionParamsSchema.parse(request.params);
    const input = DeleteProductConversionRequestSchema.parse(request.body);
    return {
      data: await repository.retireProductConversion(
        session.principal,
        productId,
        conversionId,
        input,
        requestContext(request),
      ),
    };
  });

  app.get('/api/v1/warehouse-balances', async (request) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    return repository.listWarehouseBalances(session.principal);
  });

  app.get('/api/v1/inbound-receipts', async (request) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const query = ListInboundReceiptsQuerySchema.parse(request.query);
    return repository.listInboundReceipts(session.principal, query);
  });

  app.get('/api/v1/inbound-receipts/:receiptId', async (request) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const { receiptId } = InboundReceiptParamsSchema.parse(request.params);
    return { data: await repository.getInboundReceipt(session.principal, receiptId) };
  });

  app.post('/api/v1/inbound-receipts', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const input = CreateInboundReceiptRequestSchema.parse(request.body);
    const result = await repository.receiveSupplierInbound(
      session.principal,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({
        action: 'RECEIVE_SUPPLIER_INBOUND',
        ...input,
        bags: [...input.bags].sort(
          (left, right) =>
            left.productId.localeCompare(right.productId) ||
            left.bagCode.localeCompare(right.bagCode),
        ),
      }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.status(201).send({ data: result.data });
  });

  app.post('/api/v1/inbound-receipts/:receiptId/confirm-costs', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { receiptId } = InboundReceiptParamsSchema.parse(request.params);
    const input = ConfirmReceiptCostsRequestSchema.parse(request.body);
    const result = await repository.confirmSupplierInboundCosts(
      session.principal,
      receiptId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({
        action: 'CONFIRM_SUPPLIER_INBOUND_COSTS',
        receiptId,
        ...input,
        productCosts: [...input.productCosts].sort((left, right) =>
          left.productId.localeCompare(right.productId),
        ),
      }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.post('/api/v1/inbound-receipts/:receiptId/cancel', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { receiptId } = InboundReceiptParamsSchema.parse(request.params);
    const input = CancelInboundReceiptRequestSchema.parse(request.body);
    const result = await repository.cancelSupplierInbound(
      session.principal,
      receiptId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ action: 'CANCEL_SUPPLIER_INBOUND', receiptId, ...input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.get('/api/v1/stores', async (request) => {
    const session = await authenticate(request, repository);
    const query = ListStoresQuerySchema.parse(request.query);
    return repository.listStores(session.principal, query);
  });

  app.post('/api/v1/stores', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN']);
    const input = CreateStoreRequestSchema.parse(request.body);
    const store = await repository.createStore(session.principal, input, requestContext(request));
    return reply.status(201).send({ data: store });
  });

  app.get('/api/v1/order-requests', async (request) => {
    const session = await authenticate(request, repository);
    const query = ListStoreOrderRequestsQuerySchema.parse(request.query);
    return repository.listOrderRequests(session.principal, query);
  });

  app.post('/api/v1/order-requests', async (request, reply) => {
    const session = await authenticate(request, repository);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const input = CreateStoreOrderRequestSchema.parse(request.body);
    const canonicalRequest = {
      businessSessionId: input.businessSessionId,
      storeId: input.storeId,
      items: [...input.items].sort((left, right) => left.productId.localeCompare(right.productId)),
    };
    const submitted = await repository.submitOrderRequest(
      session.principal,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest(canonicalRequest),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(submitted.replayed));
    return reply.status(201).send({ data: submitted.data });
  });

  app.get('/api/v1/store-receipts', async (request) => {
    const session = await authenticate(request, repository);
    const query = ListReceiptsQuerySchema.parse(request.query);
    return repository.listReceipts(session.principal, query);
  });

  app.get('/api/v1/store-receipt-sources', async (request) => {
    const session = await authenticate(request, repository);
    const query = ListStoreReceiptSourcesQuerySchema.parse(request.query);
    return repository.listStoreReceiptSources(session.principal, query);
  });

  app.get('/api/v1/store-receipts/:receiptId', async (request) => {
    const session = await authenticate(request, repository);
    const { receiptId } = ReceiptParamsSchema.parse(request.params);
    return { data: await repository.getReceipt(session.principal, receiptId) };
  });

  app.post('/api/v1/store-receipts', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const input = DeclareStoreReceiptRequestSchema.parse(request.body);
    const result = await repository.declareStoreReceipt(
      session.principal,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({
        action: 'DECLARE_STORE_RECEIPT',
        storeId: input.storeId,
        outboundRequestId: input.outboundRequestId,
        lines: [...input.lines].sort((left, right) =>
          left.productId.localeCompare(right.productId),
        ),
        discrepancyNote: input.discrepancyNote,
      }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.status(201).send({ data: result.data });
  });

  app.post('/api/v1/store-receipts/:receiptId/submit', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { receiptId } = ReceiptParamsSchema.parse(request.params);
    const input = SubmitStoreReceiptRequestSchema.parse(request.body);
    const result = await repository.submitStoreReceipt(
      session.principal,
      receiptId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({
        action: 'SUBMIT_STORE_RECEIPT',
        receiptId,
        lines: [...input.lines].sort((left, right) =>
          left.productId.localeCompare(right.productId),
        ),
        discrepancyNote: input.discrepancyNote,
        expectedVersion: input.expectedVersion,
      }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.post('/api/v1/store-receipts/:receiptId/return', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { receiptId } = ReceiptParamsSchema.parse(request.params);
    const input = ReturnReceiptForCorrectionRequestSchema.parse(request.body);
    const result = await repository.returnStoreReceiptForCorrection(
      session.principal,
      receiptId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ action: 'RETURN_STORE_RECEIPT', receiptId, ...input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.post('/api/v1/store-receipts/:receiptId/finalize', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { receiptId } = ReceiptParamsSchema.parse(request.params);
    const input = FinalizeReceiptRequestSchema.parse(request.body);
    const result = await repository.finalizeStoreReceipt(
      session.principal,
      receiptId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({
        action: 'FINALIZE_STORE_RECEIPT',
        receiptId,
        ...input,
        lines: [...input.lines].sort((left, right) =>
          left.productId.localeCompare(right.productId),
        ),
      }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.get('/api/v1/store-inventory-bags', async (request) => {
    const session = await authenticate(request, repository);
    const query = ListStoreInventoryBagsQuerySchema.parse(request.query);
    return repository.listStoreInventoryBags(session.principal, query);
  });

  app.get('/api/v1/store-inventory-bags/:bagId/ledger', async (request) => {
    const session = await authenticate(request, repository);
    const { bagId } = StoreInventoryBagParamsSchema.parse(request.params);
    const query = ListStoreInventoryBagLedgerQuerySchema.parse(request.query);
    return repository.listStoreInventoryBagLedger(session.principal, bagId, query);
  });

  app.post('/api/v1/store-inventory-bags/:bagId/open', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { bagId } = StoreInventoryBagParamsSchema.parse(request.params);
    const input = OpenStoreInventoryBagRequestSchema.parse(request.body);
    const result = await repository.openStoreInventoryBag(
      session.principal,
      bagId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ action: 'OPEN_STORE_INVENTORY_BAG', bagId, ...input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.get('/api/v1/store-outbounds', async (request) => {
    const session = await authenticate(request, repository);
    const query = ListStoreOutboundsQuerySchema.parse(request.query);
    return repository.listStoreOutbounds(session.principal, query);
  });

  app.post('/api/v1/store-outbounds', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const input = CreateStoreOutboundRequestSchema.parse(request.body);
    const result = await repository.createStoreOutbound(
      session.principal,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ action: 'CREATE_STORE_OUTBOUND', ...input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.status(201).send({ data: result.data });
  });

  app.post('/api/v1/store-outbounds/:outboundId/review', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['ADMIN', 'HTKD']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { outboundId } = StoreOutboundParamsSchema.parse(request.params);
    const input = ReviewStoreOutboundRequestSchema.parse(request.body);
    const result = await repository.reviewStoreOutbound(
      session.principal,
      outboundId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ action: 'REVIEW_STORE_OUTBOUND', outboundId, ...input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.get('/api/v1/store-transfers', async (request) => {
    const session = await authenticate(request, repository);
    const query = ListStoreTransfersQuerySchema.parse(request.query);
    return repository.listStoreTransfers(session.principal, query);
  });

  app.get('/api/v1/store-transfers/destinations', async (request) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    return { data: await repository.listStoreTransferDestinations(session.principal) };
  });

  app.post('/api/v1/store-transfers', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const input = CreateStoreTransferRequestSchema.parse(request.body);
    const result = await repository.createStoreTransfer(
      session.principal,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ action: 'CREATE_STORE_TRANSFER', ...input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.status(201).send({ data: result.data });
  });

  app.post('/api/v1/store-transfers/:transferId/dispatch', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { transferId } = StoreTransferParamsSchema.parse(request.params);
    const input = DispatchStoreTransferRequestSchema.parse(request.body);
    const result = await repository.dispatchStoreTransfer(
      session.principal,
      transferId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ action: 'DISPATCH_STORE_TRANSFER', transferId, ...input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.post('/api/v1/store-transfers/:transferId/receive', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { transferId } = StoreTransferParamsSchema.parse(request.params);
    const input = ReceiveStoreTransferRequestSchema.parse(request.body);
    const result = await repository.receiveStoreTransfer(
      session.principal,
      transferId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ action: 'RECEIVE_STORE_TRANSFER', transferId, ...input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.post('/api/v1/store-transfers/:transferId/cancel', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { transferId } = StoreTransferParamsSchema.parse(request.params);
    const input = CancelStoreTransferRequestSchema.parse(request.body);
    const result = await repository.cancelStoreTransfer(
      session.principal,
      transferId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ action: 'CANCEL_STORE_TRANSFER', transferId, ...input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.get('/api/v1/wait-tickets', async (request) => {
    const session = await authenticate(request, repository);
    const query = ListWaitTicketsQuerySchema.parse(request.query);
    return repository.listWaitTickets(session.principal, query);
  });

  app.get('/api/v1/wait-tickets/:waitTicketId/history', async (request) => {
    const session = await authenticate(request, repository);
    const { waitTicketId } = WaitTicketParamsSchema.parse(request.params);
    const { limit } = WaitTicketHistoryQuerySchema.parse(request.query);
    return {
      data: await repository.getWaitTicketHistory(session.principal, waitTicketId, limit),
    };
  });

  app.post('/api/v1/wait-tickets/:waitTicketId/cancel', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { waitTicketId } = WaitTicketParamsSchema.parse(request.params);
    const input = CancelWaitTicketRequestSchema.parse(request.body);
    const result = await repository.cancelWaitTicket(
      session.principal,
      waitTicketId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ action: 'CANCEL_WAIT_TICKET', waitTicketId, ...input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.get('/api/v1/priority-offers', async (request) => {
    const session = await authenticate(request, repository);
    const query = ListPriorityOffersQuerySchema.parse(request.query);
    return repository.listPriorityOffers(session.principal, query);
  });

  app.post('/api/v1/priority-offers/:offerId/respond', async (request, reply) => {
    const session = await authenticate(request, repository);
    requireRole(session.principal, ['STORE']);
    const headers = IdempotencyHeadersSchema.parse(request.headers);
    const { offerId } = PriorityOfferParamsSchema.parse(request.params);
    const input = RespondPriorityOfferRequestSchema.parse(request.body);
    const result = await repository.respondPriorityOffer(
      session.principal,
      offerId,
      input,
      headers['idempotency-key'],
      hashCanonicalRequest({ operation: 'RESPOND_PRIORITY_OFFER', offerId, response: input }),
      requestContext(request),
    );
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.send({ data: result.data });
  });

  app.get('/api/v1/reports/monthly', async (request) => {
    const session = await authenticate(request, repository);
    const query = MonthlyOperationalReportQuerySchema.parse(request.query);
    return {
      data: await repository.getMonthlyOperationalReport(session.principal, query),
    };
  });

  app.get('/api/v1/integrations/warehouse/v1/order-statistics', async (request) => {
    const session = await authenticate(request, repository);
    const query = StatisticsQuerySchema.parse(request.query);
    return repository.getOrderStatistics(session.principal, query.storeCode, query.from, query.to);
  });

  return app;
}

async function authenticate(
  request: FastifyRequest,
  repository: WarehouseRepository,
): Promise<Session> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) throw unauthenticated();
  return repository.resolveSession(token);
}

function assertActiveAccount(account: AccountCredentials): void {
  if (account.status !== 'ACTIVE') {
    throw new ApiError('ACCOUNT_INACTIVE', 'Tài khoản đã bị khóa hoặc vô hiệu hóa', 403);
  }
}

function requireRole(
  principal: AuthenticatedPrincipal,
  allowed: readonly AuthenticatedPrincipal['role'][],
): void {
  if (!allowed.includes(principal.role)) throw forbidden();
}

function requestContext(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    requestId: request.id,
    ipAddress: request.ip || null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 1_000) : null,
  };
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const encoded = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(encoded);
    } catch {
      return null;
    }
  }
  return null;
}

function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    `Expires=${expiresAt.toUTCString()}`,
  ].join('; ');
}

function clearSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ].join('; ');
}

function applyCors(
  request: FastifyRequest,
  reply: FastifyReply,
  configuredOrigin: string | readonly string[] | undefined,
): void {
  const requestOrigin = request.headers.origin;
  if (!requestOrigin) return;
  if (!isAllowedOrigin(requestOrigin, configuredOrigin)) return;
  reply.header('access-control-allow-origin', requestOrigin);
  reply.header('access-control-allow-credentials', 'true');
  reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  reply.header('access-control-allow-headers', 'content-type,idempotency-key,x-request-id');
  reply.header('vary', 'Origin');
}

function isAllowedOrigin(
  requestOrigin: string,
  configuredOrigin: string | readonly string[] | undefined,
): boolean {
  const allowed = Array.isArray(configuredOrigin)
    ? configuredOrigin
    : [configuredOrigin ?? 'http://localhost:5173'];
  return allowed.includes(requestOrigin);
}

function integrationStatus(options: CreateApiOptions): {
  readonly endpoint: string;
  readonly status: 'CONFIGURED' | 'NOT_CONFIGURED';
} {
  const endpoint = options.idosiIntegrationEndpoint?.trim() || DEFAULT_IDOSI_INTEGRATION_ENDPOINT;
  if (endpoint.length > 2_048) throw new Error('IDOSI integration endpoint is too long');
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('IDOSI integration endpoint must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('IDOSI integration endpoint must use HTTP or HTTPS');
  }
  return {
    endpoint,
    status: options.idosiIntegrationSecretConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
  };
}

function zodFieldErrors(error: ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length === 0 ? '$' : issue.path.join('.');
    (result[path] ??= []).push(issue.message);
  }
  return result;
}

function errorEnvelope(code: ApiErrorCode, message: string, requestId: string): object {
  return { error: { code, message, requestId } };
}

function openApiDocument(): Record<string, unknown> {
  const cookieSecurity = [{ cookieSession: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'KHOHANG-IDOSI API',
      version: '0.1.0',
      description: 'Warehouse, catalog and two-slot order request API.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        cookieSession: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
      },
    },
    paths: {
      '/health': { get: { summary: 'Liveness', responses: { '200': { description: 'Live' } } } },
      '/ready': {
        get: {
          summary: 'Dependency readiness',
          responses: {
            '200': { description: 'Ready' },
            '503': { description: 'Not ready' },
          },
        },
      },
      '/api/v1/auth/login': {
        post: {
          summary: 'Create an opaque session',
          responses: {
            '200': { description: 'Session' },
            '429': { description: 'Too many failed login attempts' },
          },
        },
      },
      '/api/v1/auth/logout': {
        post: {
          summary: 'Revoke current session',
          responses: { '200': { description: 'Revoked' } },
        },
      },
      '/api/v1/auth/session': {
        get: { security: cookieSecurity, responses: { '200': { description: 'Current session' } } },
      },
      '/api/v1/admin/accounts': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Paginated accounts (ADMIN only)' } },
        },
        post: {
          security: cookieSecurity,
          responses: { '201': { description: 'Created account (ADMIN only)' } },
        },
      },
      '/api/v1/admin/accounts/{accountId}': {
        patch: {
          security: cookieSecurity,
          responses: { '200': { description: 'Updated account (ADMIN only)' } },
        },
      },
      '/api/v1/admin/accounts/{accountId}/reset-password': {
        post: {
          security: cookieSecurity,
          responses: { '200': { description: 'Password reset and sessions revoked' } },
        },
      },
      '/api/v1/admin/audit-logs': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Filtered immutable audit history (ADMIN only)' } },
        },
      },
      '/api/v1/admin/operational-settings': {
        get: {
          security: cookieSecurity,
          responses: {
            '200': { description: 'Current and versioned operational settings (ADMIN only)' },
          },
        },
        put: {
          security: cookieSecurity,
          responses: {
            '200': { description: 'Created immutable operational settings version (ADMIN only)' },
            '409': { description: 'Optimistic settings version conflict' },
          },
        },
      },
      '/api/v1/products': {
        get: { security: cookieSecurity, responses: { '200': { description: 'Products' } } },
        post: {
          security: cookieSecurity,
          responses: { '201': { description: 'Created product' } },
        },
      },
      '/api/v1/products/{productId}': {
        patch: {
          security: cookieSecurity,
          responses: { '200': { description: 'Updated product' } },
        },
      },
      '/api/v1/products/{productId}/conversions': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Conversion history' } },
        },
        post: {
          security: cookieSecurity,
          responses: {
            '201': { description: 'Initial or resumed immutable conversion version' },
          },
        },
      },
      '/api/v1/product-conversions': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Paginated conversion projection for all products' } },
        },
      },
      '/api/v1/products/{productId}/conversions/{conversionId}': {
        patch: {
          security: cookieSecurity,
          responses: { '200': { description: 'New immutable version' } },
        },
        delete: {
          security: cookieSecurity,
          responses: { '200': { description: 'Retired conversion' } },
        },
      },
      '/api/v1/stores': {
        get: { security: cookieSecurity, responses: { '200': { description: 'Scoped stores' } } },
        post: { security: cookieSecurity, responses: { '201': { description: 'Created store' } } },
      },
      '/api/v1/order-requests': {
        get: { security: cookieSecurity, responses: { '200': { description: 'Scoped requests' } } },
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '201': { description: 'Submitted or replayed request' } },
        },
      },
      '/api/v1/order-sessions': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Paginated order sessions' } },
        },
      },
      '/api/v1/warehouse-balances': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Current warehouse balances (ADMIN/HTKD)' } },
        },
      },
      '/api/v1/inbound-receipts': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Paginated supplier inbound receipts' } },
        },
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '201': { description: 'Received supplier bags and increased warehouse stock' },
          },
        },
      },
      '/api/v1/inbound-receipts/{receiptId}': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Supplier inbound receipt detail' } },
        },
      },
      '/api/v1/inbound-receipts/{receiptId}/confirm-costs': {
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Confirmed exact supplier receipt costs' } },
        },
      },
      '/api/v1/inbound-receipts/{receiptId}/cancel': {
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Cancelled pending supplier stock receipt' } },
        },
      },
      '/api/v1/store-receipts': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Scoped store receipts' } },
        },
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '201': { description: 'Declared store receipt' } },
        },
      },
      '/api/v1/store-receipt-sources': {
        get: {
          security: cookieSecurity,
          responses: {
            '200': { description: 'Scoped dispatched requests eligible for store receipt' },
          },
        },
      },
      '/api/v1/store-receipts/{receiptId}': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Store receipt detail' } },
        },
      },
      '/api/v1/store-receipts/{receiptId}/submit': {
        post: {
          security: cookieSecurity,
          responses: { '200': { description: 'Submitted for HTKD review' } },
        },
      },
      '/api/v1/store-receipts/{receiptId}/return': {
        post: {
          security: cookieSecurity,
          responses: { '200': { description: 'Returned for store correction' } },
        },
      },
      '/api/v1/store-receipts/{receiptId}/finalize': {
        post: {
          security: cookieSecurity,
          responses: { '200': { description: 'Finalized receipt and inventory' } },
        },
      },
      '/api/v1/store-inventory-bags': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Scoped store inventory bags' } },
        },
      },
      '/api/v1/store-inventory-bags/{bagId}/ledger': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Auditable inventory bag ledger' } },
        },
      },
      '/api/v1/store-inventory-bags/{bagId}/open': {
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Opened or replayed inventory bag mutation' } },
        },
      },
      '/api/v1/store-outbounds': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Scoped store outbounds' } },
        },
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '201': { description: 'Created or replayed store outbound' } },
        },
      },
      '/api/v1/store-outbounds/{outboundId}/review': {
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Approved, rejected or replayed store outbound' } },
        },
      },
      '/api/v1/store-transfers': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Transfers visible to the caller store scope' } },
        },
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '201': { description: 'Created or replayed draft store transfer' } },
        },
      },
      '/api/v1/store-transfers/destinations': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Active retail transfer destinations' } },
        },
      },
      '/api/v1/store-transfers/{transferId}/dispatch': {
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Dispatched transfer and deducted source stock' } },
        },
      },
      '/api/v1/store-transfers/{transferId}/receive': {
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Received transfer and created destination lot' } },
        },
      },
      '/api/v1/store-transfers/{transferId}/cancel': {
        post: {
          security: cookieSecurity,
          parameters: [
            { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Cancelled an undispatched draft transfer' } },
        },
      },
      '/api/v1/wait-tickets': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Scoped wait tickets' } },
        },
      },
      '/api/v1/wait-tickets/{waitTicketId}/history': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Ticket, offer and audit history' } },
        },
      },
      '/api/v1/wait-tickets/{waitTicketId}/cancel': {
        post: {
          security: cookieSecurity,
          responses: { '200': { description: 'Cancelled wait ticket' } },
        },
      },
      '/api/v1/priority-offers': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Scoped priority offers' } },
        },
      },
      '/api/v1/priority-offers/{offerId}/respond': {
        post: {
          security: cookieSecurity,
          responses: { '200': { description: 'Accepted or declined priority offer' } },
        },
      },
      '/api/v1/reports/monthly': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Source-backed monthly operational report' } },
        },
      },
      '/api/v1/integrations/warehouse/v1/order-statistics': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Store statistics' } },
        },
      },
    },
  };
}
