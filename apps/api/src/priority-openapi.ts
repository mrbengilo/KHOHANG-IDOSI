/** Emergency commands have their own identity; no session/run/decision is created. */
const uuid = { type: 'string', format: 'uuid' };
const key = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 1 },
};
const id = { name: 'id', in: 'path', required: true, schema: uuid };
const store = { name: 'storeId', in: 'query', schema: uuid };
const errors = {
  '400': { description: 'Invalid payload or missing idempotency key' },
  '401': { description: 'Session expired or account inactive' },
  '403': { description: 'Role/store scope denied' },
  '409': {
    description:
      'Source revision, availability, version or idempotency conflict; nothing committed',
  },
};
const input = {
  type: 'object',
  additionalProperties: false,
  required: ['storeId', 'sources', 'additionalLines'],
  properties: {
    storeId: uuid,
    sources: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'revision'],
        properties: { id: uuid, revision: { type: 'string', minLength: 1, maxLength: 100 } },
      },
    },
    additionalLines: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['productId', 'quantity'],
        properties: { productId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 10000 } },
      },
    },
    notes: { type: 'string', maxLength: 500, default: '' },
  },
};
const body = { required: true, content: { 'application/json': { schema: input } } };
export const priorityOrderPaths = {
  '/api/v1/priority-orders/context': {
    get: {
      summary:
        'ADMIN/HTKD: active stores, paged held sources, product availability and read-only wait references',
      parameters: [
        store,
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
      ],
      responses: {
        '200': {
          description:
            'PriorityContext envelope, 50 sources/page, sourcePage and sourcesHaveMore; no-store',
        },
        ...errors,
      },
    },
  },
  '/api/v1/priority-orders/availability': {
    get: {
      summary: 'ADMIN/HTKD: current available and maximum additional bags for one SKU',
      parameters: [
        { ...store, required: true },
        { name: 'productId', in: 'query', required: true, schema: uuid },
      ],
      responses: {
        '200': {
          description:
            'PriorityAvailability envelope: availableBags, maxAdditionalBags, orderable, blockingReason, observedAt; no-store',
        },
        ...errors,
      },
    },
  },
  '/api/v1/priority-orders/preview': {
    post: {
      summary: 'Read-only server validation, does not reserve stock',
      requestBody: body,
      responses: {
        '200': { description: 'data: totalQuantity and products with current availability' },
        ...errors,
      },
    },
  },
  '/api/v1/priority-orders': {
    get: {
      summary: 'Scoped emergency orders including source RE codes, status and history',
      parameters: [
        store,
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        {
          name: 'pageSize',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        '200': { description: 'PriorityOrderPage: data and pagination; no-store' },
        ...errors,
      },
    },
    post: {
      summary: 'ADMIN/HTKD: approve, issue, create RE and dispatch atomically',
      parameters: [key],
      requestBody: body,
      responses: {
        '201': {
          description:
            'Committed PriorityOrder envelope; Idempotency-Replayed header; issued old sources are not issued again',
        },
        ...errors,
      },
    },
  },
  '/api/v1/priority-orders/{id}': {
    get: {
      summary: 'Read one scoped emergency order',
      parameters: [id],
      responses: {
        '200': { description: 'PriorityOrder envelope' },
        '404': { description: 'Not found or outside store scope' },
        ...errors,
      },
    },
  },
  '/api/v1/priority-orders/{id}/reshare-status': {
    put: {
      summary: 'ADMIN/HTKD: audited, versioned Reshare ordering status; never reverses stock',
      parameters: [id, key],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['status', 'expectedVersion'],
              properties: {
                status: { type: 'string', enum: ['ORDERED', 'NOT_ORDERED'] },
                expectedVersion: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
      responses: { '200': { description: 'Updated PriorityOrder envelope' }, ...errors },
    },
  },
};
