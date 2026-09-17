import { randomUUID } from 'node:crypto';

import {
  CreateProductRequestSchema,
  CreateProductConversionRequestSchema,
  CreateStoreOrderRequestSchema,
  CreateStoreRequestSchema,
  IdempotencyHeadersSchema,
  IsoDateSchema,
  ListOrderSessionsQuerySchema,
  ListProductsQuerySchema,
  ListProductConversionsQuerySchema,
  ListStoreOrderRequestsQuerySchema,
  ListStoresQuerySchema,
  LoginRequestSchema,
  ProductParamsSchema,
  ProductConversionParamsSchema,
  DeleteProductConversionRequestSchema,
  UpdateProductConversionRequestSchema,
  UpdateProductRequestSchema,
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
}

export async function createApi(options: CreateApiOptions = {}): Promise<FastifyInstance> {
  const repository = options.repository ?? (await MemoryWarehouseRepository.create());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new Error('sessionTtlMs must be a positive safe integer');
  }
  const dummyPasswordHash = await hashPassword(randomUUID());
  const loginRateLimiter = new LoginRateLimiter(options.loginRateLimit);
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
  reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
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
          responses: { '201': { description: 'Initial conversion' } },
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
      '/api/v1/integrations/warehouse/v1/order-statistics': {
        get: {
          security: cookieSecurity,
          responses: { '200': { description: 'Store statistics' } },
        },
      },
    },
  };
}
