import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const userRoleEnum = pgEnum('user_role', ['admin', 'htkd', 'store', 'wholesale']);
/** Derived from the enum so adding a role cannot leave a hand-written union behind. */
export type DatabaseUserRole = (typeof userRoleEnum.enumValues)[number];
export const userStatusEnum = pgEnum('user_status', ['active', 'locked', 'disabled']);
export const storeKindEnum = pgEnum('store_kind', ['retail', 'wholesale']);
export const productUnitEnum = pgEnum('product_unit', ['item', 'bag', 'kilogram']);
export const orderSessionStatusEnum = pgEnum('order_session_status', [
  'draft',
  'open',
  'closed',
  'allocating',
  'completed',
  'cancelled',
]);
export const orderRequestStatusEnum = pgEnum('order_request_status', [
  'draft',
  'submitted',
  'merged',
  'partially_allocated',
  'allocated',
  'waitlisted',
  'cancelled',
]);
export const mergedOrderStatusEnum = pgEnum('merged_order_status', [
  'pending',
  'ready',
  'allocated',
  'cancelled',
]);
export const waitTicketStatusEnum = pgEnum('wait_ticket_status', [
  'active',
  'fulfilled',
  'cancelled',
  'expired',
]);
export const priorityLevelEnum = pgEnum('priority_level', ['P0A', 'P0B', 'P1', 'P2', 'P3']);
export const priorityOfferStatusEnum = pgEnum('priority_offer_status', [
  'offered',
  'accepted',
  'declined',
  'expired',
  'cancelled',
]);
export const inventorySnapshotTypeEnum = pgEnum('inventory_snapshot_type', [
  'opening_0800',
  'pre_allocation',
  'manual',
]);
export const inventorySnapshotStatusEnum = pgEnum('inventory_snapshot_status', [
  'capturing',
  'completed',
  'failed',
]);
export const allocationRunStatusEnum = pgEnum('allocation_run_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export const allocationLineStatusEnum = pgEnum('allocation_line_status', [
  'allocated',
  'partial',
  'waitlisted',
  'skipped',
]);
export const reservationStatusEnum = pgEnum('reservation_status', [
  'active',
  'consumed',
  'released',
  'expired',
  'cancelled',
]);
export const receiptStatusEnum = pgEnum('receipt_status', [
  'draft',
  'submitted',
  'confirmed',
  'cancelled',
]);
export const receiptCostTypeEnum = pgEnum('receipt_cost_type', [
  'goods',
  'shipping',
  'handling',
  'other',
  'vat',
]);
export const storeReceiptStatusEnum = pgEnum('store_receipt_status', [
  'draft',
  'pending_htkd',
  'returned',
  'finalized',
]);
export const storeInventoryBagStatusEnum = pgEnum('store_inventory_bag_status', [
  'in_transit',
  'available',
  'opened',
  'depleted',
  'quarantined',
  'returned',
  'lost',
]);
export const storeInventoryLedgerEventTypeEnum = pgEnum('store_inventory_ledger_event_type', [
  'receive',
  'consume',
  'adjust',
  'quarantine',
  'release',
]);
export const storeOutboundStatusEnum = pgEnum('store_outbound_status', [
  'pending',
  'approved',
  'rejected',
]);
export const storeOutboundReasonEnum = pgEnum('store_outbound_reason', [
  'discount_sale',
  'sale_kg',
  'sale_piece',
  'charity',
  'cancel',
  'torn',
  'defective',
  'dirty',
  'other',
]);
export const storeTransferStatusEnum = pgEnum('store_transfer_status', [
  'draft',
  'in_transit',
  'received',
  'cancelled',
]);
export const outboundRequestStatusEnum = pgEnum('outbound_request_status', [
  'draft',
  'submitted',
  'approved',
  'reserved',
  'dispatched',
  'partially_received',
  'received',
  'completed',
  'cancelled',
]);
export const warehouseLedgerEventTypeEnum = pgEnum('warehouse_ledger_event_type', [
  'opening_balance',
  'receipt',
  'reservation',
  'reservation_release',
  'outbound',
  'return',
  'adjustment',
]);
export const idempotencyStatusEnum = pgEnum('idempotency_status', [
  'in_progress',
  'completed',
  'failed',
]);

export const storeGroups = pgTable(
  'store_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    displayOrder: integer('display_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('store_groups_code_not_blank', sql`length(btrim(${table.code})) > 0`),
    check('store_groups_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('store_groups_display_order_nonnegative', sql`${table.displayOrder} >= 0`),
    check('store_groups_version_nonnegative', sql`${table.version} >= 0`),
  ],
);

export const stores = pgTable(
  'stores',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => storeGroups.id, { onDelete: 'restrict' }),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    kind: storeKindEnum('kind').notNull().default('retail'),
    address: text('address'),
    timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'),
    displayOrder: integer('display_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('stores_group_active_idx').on(table.groupId, table.isActive, table.displayOrder),
    index('stores_kind_active_idx').on(table.kind, table.isActive, table.displayOrder),
    check('stores_code_not_blank', sql`length(btrim(${table.code})) > 0`),
    check('stores_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('stores_display_order_nonnegative', sql`${table.displayOrder} >= 0`),
    check('stores_version_nonnegative', sql`${table.version} >= 0`),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    role: userRoleEnum('role').notNull(),
    status: userStatusEnum('status').notNull().default('active'),
    tokenVersion: integer('token_version').notNull().default(0),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('users_active_email_uidx')
      .on(table.email)
      .where(sql`${table.status} = 'active' AND ${table.deletedAt} IS NULL`),
    index('users_email_idx').on(table.email),
    uniqueIndex('users_one_store_account_uidx')
      .on(table.storeId)
      .where(
        sql`${table.role} = 'store' AND ${table.status} = 'active' AND ${table.deletedAt} IS NULL`,
      ),
    index('users_store_status_idx').on(table.storeId, table.status),
    check(
      'users_email_canonical',
      sql`length(${table.email}) BETWEEN 3 AND 80 AND ${table.email} = btrim(${table.email})`,
    ),
    check('users_password_hash_not_blank', sql`length(${table.passwordHash}) >= 20`),
    check('users_display_name_not_blank', sql`length(btrim(${table.displayName})) > 0`),
    check('users_token_version_nonnegative', sql`${table.tokenVersion} >= 0`),
    check(
      'users_store_scope_matches_role',
      sql`(${table.role} = 'store' AND ${table.storeId} IS NOT NULL) OR (${table.role} <> 'store' AND ${table.storeId} IS NULL)`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userTokenVersion: integer('user_token_version').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sessions_user_active_idx')
      .on(table.userId, table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    index('sessions_expiry_idx').on(table.expiresAt),
    check('sessions_token_hash_not_blank', sql`length(${table.tokenHash}) >= 32`),
    check('sessions_token_version_nonnegative', sql`${table.userTokenVersion} >= 0`),
    check('sessions_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const htkdAssignments = pgTable(
  'htkd_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('htkd_assignments_active_uidx')
      .on(table.userId, table.storeId)
      .where(sql`${table.revokedAt} IS NULL`),
    index('htkd_assignments_store_active_idx')
      .on(table.storeId, table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      'htkd_assignments_revoke_after_assignment',
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.assignedAt}`,
    ),
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sku: text('sku').notNull().unique(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    unit: productUnitEnum('unit').notNull().default('bag'),
    standardBagWeightKg: numeric('standard_bag_weight_kg', {
      precision: 14,
      scale: 3,
    }),
    displayOrder: integer('display_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('products_active_display_idx').on(table.isActive, table.displayOrder),
    check('products_sku_not_blank', sql`length(btrim(${table.sku})) > 0`),
    check('products_slug_not_blank', sql`length(btrim(${table.slug})) > 0`),
    check('products_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('products_display_order_nonnegative', sql`${table.displayOrder} >= 0`),
    check('products_version_nonnegative', sql`${table.version} >= 0`),
    check(
      'products_standard_bag_weight_nonnegative',
      sql`${table.standardBagWeightKg} IS NULL OR ${table.standardBagWeightKg} >= 0`,
    ),
  ],
);

/**
 * Append-only versions of exact item-to-kilogram ratios. A ratio means
 * `itemQuantity` items correspond to `weightKilograms` kg; `effectiveTo` is exclusive.
 */
export const productConversions = pgTable(
  'product_conversions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    itemQuantity: integer('item_quantity').notNull(),
    weightKilograms: numeric('weight_kilograms', { precision: 14, scale: 3 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    reason: text('reason').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    retiredByUserId: uuid('retired_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    retirementReason: text('retirement_reason'),
  },
  (table) => [
    uniqueIndex('product_conversions_product_version_uidx').on(table.productId, table.version),
    uniqueIndex('product_conversions_product_effective_from_uidx').on(
      table.productId,
      table.effectiveFrom,
    ),
    index('product_conversions_product_period_idx').on(
      table.productId,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    index('product_conversions_active_idx')
      .on(table.productId, table.effectiveFrom)
      .where(sql`${table.retiredAt} IS NULL`),
    check('product_conversions_version_positive', sql`${table.version} > 0`),
    check('product_conversions_item_quantity_positive', sql`${table.itemQuantity} > 0`),
    check('product_conversions_weight_positive', sql`${table.weightKilograms} > 0`),
    check(
      'product_conversions_effective_period_valid',
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom} OR (${table.effectiveTo} = ${table.effectiveFrom} AND ${table.retiredAt} IS NOT NULL)`,
    ),
    check('product_conversions_reason_not_blank', sql`length(btrim(${table.reason})) >= 3`),
    check(
      'product_conversions_retirement_consistent',
      sql`(${table.retiredAt} IS NULL AND ${table.retiredByUserId} IS NULL AND ${table.retirementReason} IS NULL) OR (${table.retiredAt} IS NOT NULL AND ${table.retiredByUserId} IS NOT NULL AND ${table.retirementReason} IS NOT NULL AND length(btrim(${table.retirementReason})) >= 3 AND ${table.effectiveTo} IS NOT NULL)`,
    ),
  ],
);

export const warehouseBalances = pgTable(
  'warehouse_balances',
  {
    productId: uuid('product_id')
      .primaryKey()
      .references(() => products.id, { onDelete: 'restrict' }),
    onHandQuantity: integer('on_hand_quantity').notNull().default(0),
    reservedQuantity: integer('reserved_quantity').notNull().default(0),
    availableQuantity: integer('available_quantity')
      .generatedAlwaysAs(sql`"on_hand_quantity" - "reserved_quantity"`)
      .notNull(),
    version: integer('version').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('warehouse_balances_on_hand_nonnegative', sql`${table.onHandQuantity} >= 0`),
    check('warehouse_balances_reserved_nonnegative', sql`${table.reservedQuantity} >= 0`),
    check(
      'warehouse_balances_reserved_not_over_on_hand',
      sql`${table.reservedQuantity} <= ${table.onHandQuantity}`,
    ),
    check('warehouse_balances_version_nonnegative', sql`${table.version} >= 0`),
  ],
);

export const warehouseLedgerEntries = pgTable(
  'warehouse_ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    eventType: warehouseLedgerEventTypeEnum('event_type').notNull(),
    onHandDelta: integer('on_hand_delta').notNull().default(0),
    reservedDelta: integer('reserved_delta').notNull().default(0),
    onHandAfter: integer('on_hand_after').notNull(),
    reservedAfter: integer('reserved_after').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    eventSequence: smallint('event_sequence').notNull().default(1),
    reason: text('reason'),
    metadata: jsonb('metadata').$type<JsonObject>().notNull().default({}),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('warehouse_ledger_source_event_uidx').on(
      table.sourceType,
      table.sourceId,
      table.productId,
      table.eventSequence,
    ),
    index('warehouse_ledger_product_occurred_idx').on(table.productId, table.occurredAt),
    index('warehouse_ledger_source_idx').on(table.sourceType, table.sourceId),
    check(
      'warehouse_ledger_nonzero_delta',
      sql`${table.onHandDelta} <> 0 OR ${table.reservedDelta} <> 0`,
    ),
    check('warehouse_ledger_on_hand_after_nonnegative', sql`${table.onHandAfter} >= 0`),
    check('warehouse_ledger_reserved_after_nonnegative', sql`${table.reservedAfter} >= 0`),
    check(
      'warehouse_ledger_reserved_after_not_over_on_hand',
      sql`${table.reservedAfter} <= ${table.onHandAfter}`,
    ),
    check('warehouse_ledger_event_sequence_positive', sql`${table.eventSequence} > 0`),
    check('warehouse_ledger_source_type_not_blank', sql`length(btrim(${table.sourceType})) > 0`),
  ],
);

export const orderSessions = pgTable(
  'order_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: text('code').notNull().unique(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    status: orderSessionStatusEnum('status').notNull().default('draft'),
    inventorySnapshotDueAt: timestamp('inventory_snapshot_due_at', {
      withTimezone: true,
    }).notNull(),
    requestDeadlineAt: timestamp('request_deadline_at', { withTimezone: true }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    policyVersion: text('policy_version').notNull(),
    version: integer('version').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('order_sessions_business_date_status_idx').on(table.businessDate, table.status),
    check('order_sessions_code_not_blank', sql`length(btrim(${table.code})) > 0`),
    check(
      'order_sessions_deadline_order',
      sql`${table.requestDeadlineAt} >= ${table.inventorySnapshotDueAt}`,
    ),
    check(
      'order_sessions_close_after_open',
      sql`${table.closedAt} IS NULL OR ${table.openedAt} IS NULL OR ${table.closedAt} >= ${table.openedAt}`,
    ),
    check('order_sessions_version_nonnegative', sql`${table.version} >= 0`),
  ],
);

export const orderRequests = pgTable(
  'order_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderSessionId: uuid('order_session_id')
      .notNull()
      .references(() => orderSessions.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    requestNumber: smallint('request_number').notNull(),
    status: orderRequestStatusEnum('status').notNull().default('draft'),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('order_requests_session_store_slot_uidx').on(
      table.orderSessionId,
      table.storeId,
      table.requestNumber,
    ),
    index('order_requests_store_created_idx').on(table.storeId, table.createdAt),
    index('order_requests_session_status_idx').on(table.orderSessionId, table.status),
    check('order_requests_max_two_slots', sql`${table.requestNumber} BETWEEN 1 AND 2`),
    check(
      'order_requests_submission_timestamp',
      sql`${table.status} = 'draft' OR ${table.submittedAt} IS NOT NULL`,
    ),
    check(
      'order_requests_cancellation_timestamp',
      sql`${table.status} <> 'cancelled' OR ${table.cancelledAt} IS NOT NULL`,
    ),
  ],
);

export const orderRequestItems = pgTable(
  'order_request_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderRequestId: uuid('order_request_id')
      .notNull()
      .references(() => orderRequests.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    requestedQuantity: integer('requested_quantity').notNull(),
    priorityLevel: priorityLevelEnum('priority_level').notNull().default('P1'),
    allocatedQuantity: integer('allocated_quantity').notNull().default(0),
    waitlistedQuantity: integer('waitlisted_quantity').notNull().default(0),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('order_request_items_request_product_uidx').on(
      table.orderRequestId,
      table.productId,
    ),
    index('order_request_items_product_idx').on(table.productId),
    check('order_request_items_requested_positive', sql`${table.requestedQuantity} > 0`),
    check('order_request_items_priority_not_p0a', sql`${table.priorityLevel} <> 'P0A'`),
    check('order_request_items_allocated_nonnegative', sql`${table.allocatedQuantity} >= 0`),
    check('order_request_items_waitlisted_nonnegative', sql`${table.waitlistedQuantity} >= 0`),
    check(
      'order_request_items_resolution_not_over_requested',
      sql`${table.allocatedQuantity} + ${table.waitlistedQuantity} <= ${table.requestedQuantity}`,
    ),
  ],
);

export const mergedOrders = pgTable(
  'merged_orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderSessionId: uuid('order_session_id')
      .notNull()
      .references(() => orderSessions.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    version: integer('version').notNull().default(1),
    status: mergedOrderStatusEnum('status').notNull().default('pending'),
    requestCount: integer('request_count').notNull().default(0),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    generatedByUserId: uuid('generated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('merged_orders_session_store_version_uidx').on(
      table.orderSessionId,
      table.storeId,
      table.version,
    ),
    index('merged_orders_session_status_idx').on(table.orderSessionId, table.status),
    check('merged_orders_version_positive', sql`${table.version} > 0`),
    check('merged_orders_request_count_nonnegative', sql`${table.requestCount} >= 0`),
  ],
);

export const mergedOrderItems = pgTable(
  'merged_order_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mergedOrderId: uuid('merged_order_id')
      .notNull()
      .references(() => mergedOrders.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    requestedQuantity: integer('requested_quantity').notNull(),
    priorityLevel: priorityLevelEnum('priority_level').notNull().default('P1'),
    allocatedQuantity: integer('allocated_quantity').notNull().default(0),
    waitlistedQuantity: integer('waitlisted_quantity').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merged_order_items_order_product_uidx').on(table.mergedOrderId, table.productId),
    index('merged_order_items_product_idx').on(table.productId),
    check('merged_order_items_requested_positive', sql`${table.requestedQuantity} > 0`),
    check('merged_order_items_priority_not_p0a', sql`${table.priorityLevel} <> 'P0A'`),
    check('merged_order_items_allocated_nonnegative', sql`${table.allocatedQuantity} >= 0`),
    check('merged_order_items_waitlisted_nonnegative', sql`${table.waitlistedQuantity} >= 0`),
    check(
      'merged_order_items_resolution_not_over_requested',
      sql`${table.allocatedQuantity} + ${table.waitlistedQuantity} <= ${table.requestedQuantity}`,
    ),
  ],
);

export const mergedOrderSources = pgTable(
  'merged_order_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mergedOrderItemId: uuid('merged_order_item_id')
      .notNull()
      .references(() => mergedOrderItems.id, { onDelete: 'restrict' }),
    orderRequestItemId: uuid('order_request_item_id')
      .notNull()
      .references(() => orderRequestItems.id, { onDelete: 'restrict' }),
    requestedQuantity: integer('requested_quantity').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merged_order_sources_request_item_uidx').on(table.orderRequestItemId),
    index('merged_order_sources_merged_item_idx').on(table.mergedOrderItemId),
    check('merged_order_sources_quantity_positive', sql`${table.requestedQuantity} > 0`),
  ],
);

export const waitTickets = pgTable(
  'wait_tickets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    sourceOrderRequestItemId: uuid('source_order_request_item_id')
      .notNull()
      .references(() => orderRequestItems.id, { onDelete: 'restrict' }),
    status: waitTicketStatusEnum('status').notNull().default('active'),
    priorityLevel: priorityLevelEnum('priority_level').notNull().default('P0B'),
    originalQuantity: integer('original_quantity').notNull(),
    remainingQuantity: integer('remaining_quantity').notNull(),
    fulfilledQuantity: integer('fulfilled_quantity').notNull().default(0),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionReason: text('resolution_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('wait_tickets_one_active_store_product_uidx')
      .on(table.storeId, table.productId)
      .where(sql`${table.status} = 'active' AND ${table.deletedAt} IS NULL`),
    index('wait_tickets_active_priority_idx')
      .on(table.productId, table.priorityLevel, table.queuedAt)
      .where(sql`${table.status} = 'active' AND ${table.deletedAt} IS NULL`),
    index('wait_tickets_store_status_idx').on(table.storeId, table.status),
    check('wait_tickets_original_positive', sql`${table.originalQuantity} > 0`),
    check('wait_tickets_remaining_nonnegative', sql`${table.remainingQuantity} >= 0`),
    check('wait_tickets_fulfilled_nonnegative', sql`${table.fulfilledQuantity} >= 0`),
    check(
      'wait_tickets_quantity_conservation',
      sql`${table.remainingQuantity} + ${table.fulfilledQuantity} = ${table.originalQuantity}`,
    ),
    check(
      'wait_tickets_active_has_remaining',
      sql`${table.status} <> 'active' OR ${table.remainingQuantity} > 0`,
    ),
  ],
);

export const dailyPriorityOffers = pgTable(
  'daily_priority_offers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    waitTicketId: uuid('wait_ticket_id')
      .notNull()
      .references(() => waitTickets.id, { onDelete: 'restrict' }),
    priorityLevel: priorityLevelEnum('priority_level').notNull(),
    roundNumber: integer('round_number').notNull().default(1),
    offeredQuantity: integer('offered_quantity').notNull(),
    acceptedQuantity: integer('accepted_quantity').notNull().default(0),
    status: priorityOfferStatusEnum('status').notNull().default('offered'),
    responseDeadlineAt: timestamp('response_deadline_at', { withTimezone: true }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('daily_priority_offers_day_store_product_round_uidx').on(
      table.businessDate,
      table.storeId,
      table.productId,
      table.roundNumber,
    ),
    uniqueIndex('daily_priority_offers_one_open_uidx')
      .on(table.businessDate, table.storeId, table.productId)
      .where(sql`${table.status} = 'offered' AND ${table.deletedAt} IS NULL`),
    index('daily_priority_offers_deadline_idx')
      .on(table.responseDeadlineAt)
      .where(sql`${table.status} = 'offered' AND ${table.deletedAt} IS NULL`),
    index('daily_priority_offers_wait_history_idx').on(table.waitTicketId, table.createdAt),
    check('daily_priority_offers_round_positive', sql`${table.roundNumber} > 0`),
    check('daily_priority_offers_quantity_positive', sql`${table.offeredQuantity} > 0`),
    check('daily_priority_offers_accepted_nonnegative', sql`${table.acceptedQuantity} >= 0`),
    check(
      'daily_priority_offers_accepted_not_over_offered',
      sql`${table.acceptedQuantity} <= ${table.offeredQuantity}`,
    ),
    check(
      'daily_priority_offers_acceptance_quantity_consistent',
      sql`(${table.status} = 'accepted' AND ${table.acceptedQuantity} = ${table.offeredQuantity}) OR (${table.status} <> 'accepted' AND ${table.acceptedQuantity} = 0)`,
    ),
    check(
      'daily_priority_offers_response_timestamp',
      sql`${table.status} NOT IN ('accepted', 'declined') OR ${table.respondedAt} IS NOT NULL`,
    ),
  ],
);

export const inventorySnapshots = pgTable(
  'inventory_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderSessionId: uuid('order_session_id').references(() => orderSessions.id, {
      onDelete: 'restrict',
    }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    snapshotType: inventorySnapshotTypeEnum('snapshot_type').notNull(),
    status: inventorySnapshotStatusEnum('status').notNull().default('capturing'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    balanceVersion: integer('balance_version').notNull(),
    capturedByUserId: uuid('captured_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('inventory_snapshots_session_day_type_uidx')
      .on(table.orderSessionId, table.businessDate, table.snapshotType)
      .where(sql`${table.orderSessionId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    index('inventory_snapshots_business_date_idx').on(
      table.businessDate,
      table.snapshotType,
      table.capturedAt,
    ),
    check('inventory_snapshots_balance_version_nonnegative', sql`${table.balanceVersion} >= 0`),
    check(
      'inventory_snapshots_completion_timestamp',
      sql`${table.status} <> 'completed' OR ${table.completedAt} IS NOT NULL`,
    ),
  ],
);

export const inventorySnapshotItems = pgTable(
  'inventory_snapshot_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => inventorySnapshots.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    onHandQuantity: integer('on_hand_quantity').notNull(),
    reservedQuantity: integer('reserved_quantity').notNull(),
    availableQuantity: integer('available_quantity').notNull(),
    warehouseBalanceVersion: integer('warehouse_balance_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inventory_snapshot_items_snapshot_product_uidx').on(
      table.snapshotId,
      table.productId,
    ),
    index('inventory_snapshot_items_product_idx').on(table.productId),
    check('inventory_snapshot_items_on_hand_nonnegative', sql`${table.onHandQuantity} >= 0`),
    check('inventory_snapshot_items_reserved_nonnegative', sql`${table.reservedQuantity} >= 0`),
    check('inventory_snapshot_items_available_nonnegative', sql`${table.availableQuantity} >= 0`),
    check(
      'inventory_snapshot_items_quantity_consistent',
      sql`${table.availableQuantity} = ${table.onHandQuantity} - ${table.reservedQuantity}`,
    ),
    check(
      'inventory_snapshot_items_balance_version_nonnegative',
      sql`${table.warehouseBalanceVersion} >= 0`,
    ),
  ],
);

export const allocationRuns = pgTable(
  'allocation_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderSessionId: uuid('order_session_id')
      .notNull()
      .references(() => orderSessions.id, { onDelete: 'restrict' }),
    mergedOrderId: uuid('merged_order_id').references(() => mergedOrders.id, {
      onDelete: 'restrict',
    }),
    inventorySnapshotId: uuid('inventory_snapshot_id')
      .notNull()
      .references(() => inventorySnapshots.id, { onDelete: 'restrict' }),
    runNumber: integer('run_number').notNull(),
    status: allocationRunStatusEnum('status').notNull().default('pending'),
    policyVersion: text('policy_version').notNull(),
    policyInput: jsonb('policy_input').$type<JsonObject>().notNull().default({}),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedQuantity: integer('requested_quantity').notNull().default(0),
    allocatedQuantity: integer('allocated_quantity').notNull().default(0),
    waitlistedQuantity: integer('waitlisted_quantity').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('allocation_runs_session_run_uidx').on(table.orderSessionId, table.runNumber),
    uniqueIndex('allocation_runs_idempotency_key_uidx').on(table.idempotencyKey),
    index('allocation_runs_status_created_idx').on(table.status, table.createdAt),
    check('allocation_runs_run_number_positive', sql`${table.runNumber} > 0`),
    check('allocation_runs_requested_nonnegative', sql`${table.requestedQuantity} >= 0`),
    check('allocation_runs_allocated_nonnegative', sql`${table.allocatedQuantity} >= 0`),
    check('allocation_runs_waitlisted_nonnegative', sql`${table.waitlistedQuantity} >= 0`),
    check(
      'allocation_runs_resolution_not_over_requested',
      sql`${table.allocatedQuantity} + ${table.waitlistedQuantity} <= ${table.requestedQuantity}`,
    ),
    check(
      'allocation_runs_finish_after_start',
      sql`${table.finishedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.finishedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const allocationLines = pgTable(
  'allocation_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    allocationRunId: uuid('allocation_run_id')
      .notNull()
      .references(() => allocationRuns.id, { onDelete: 'restrict' }),
    mergedOrderId: uuid('merged_order_id').references(() => mergedOrders.id, {
      onDelete: 'restrict',
    }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    orderRequestItemId: uuid('order_request_item_id').references(() => orderRequestItems.id, {
      onDelete: 'restrict',
    }),
    waitTicketId: uuid('wait_ticket_id').references(() => waitTickets.id, {
      onDelete: 'restrict',
    }),
    priorityOfferId: uuid('priority_offer_id').references(() => dailyPriorityOffers.id, {
      onDelete: 'restrict',
    }),
    priorityLevel: priorityLevelEnum('priority_level').notNull(),
    roundNumber: integer('round_number').notNull(),
    sequenceInRound: integer('sequence_in_round').notNull(),
    requestedQuantity: integer('requested_quantity').notNull(),
    allocatedQuantity: integer('allocated_quantity').notNull().default(0),
    waitlistedQuantity: integer('waitlisted_quantity').notNull().default(0),
    status: allocationLineStatusEnum('status').notNull(),
    reasonCode: text('reason_code').notNull(),
    decisionMetadata: jsonb('decision_metadata').$type<JsonObject>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('allocation_lines_request_round_uidx')
      .on(table.allocationRunId, table.orderRequestItemId, table.roundNumber)
      .where(sql`${table.orderRequestItemId} IS NOT NULL`),
    uniqueIndex('allocation_lines_wait_round_uidx')
      .on(table.allocationRunId, table.waitTicketId, table.roundNumber)
      .where(sql`${table.waitTicketId} IS NOT NULL`),
    uniqueIndex('allocation_lines_priority_offer_uidx')
      .on(table.priorityOfferId)
      .where(sql`${table.priorityOfferId} IS NOT NULL`),
    index('allocation_lines_run_product_round_idx').on(
      table.allocationRunId,
      table.productId,
      table.roundNumber,
      table.sequenceInRound,
    ),
    index('allocation_lines_store_run_idx').on(table.storeId, table.allocationRunId),
    check(
      'allocation_lines_exactly_one_source',
      sql`num_nonnulls(${table.orderRequestItemId}, ${table.waitTicketId}) = 1`,
    ),
    check(
      'allocation_lines_priority_source',
      sql`(${table.waitTicketId} IS NOT NULL AND ${table.priorityLevel} = 'P0A') OR (${table.orderRequestItemId} IS NOT NULL AND ${table.priorityLevel} <> 'P0A')`,
    ),
    check(
      'allocation_lines_order_has_merged_order',
      sql`${table.orderRequestItemId} IS NULL OR ${table.mergedOrderId} IS NOT NULL`,
    ),
    check('allocation_lines_round_positive', sql`${table.roundNumber} > 0`),
    check('allocation_lines_sequence_positive', sql`${table.sequenceInRound} > 0`),
    check('allocation_lines_requested_positive', sql`${table.requestedQuantity} > 0`),
    check('allocation_lines_allocated_nonnegative', sql`${table.allocatedQuantity} >= 0`),
    check('allocation_lines_waitlisted_nonnegative', sql`${table.waitlistedQuantity} >= 0`),
    check(
      'allocation_lines_resolution_not_over_requested',
      sql`${table.allocatedQuantity} + ${table.waitlistedQuantity} <= ${table.requestedQuantity}`,
    ),
  ],
);

export const outboundRequests = pgTable(
  'outbound_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestNumber: text('request_number').notNull().unique(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    orderSessionId: uuid('order_session_id').references(() => orderSessions.id, {
      onDelete: 'restrict',
    }),
    allocationRunId: uuid('allocation_run_id').references(() => allocationRuns.id, {
      onDelete: 'restrict',
    }),
    status: outboundRequestStatusEnum('status').notNull().default('draft'),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    dispatchedByUserId: uuid('dispatched_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    receivedByUserId: uuid('received_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('outbound_requests_store_status_idx').on(table.storeId, table.status, table.createdAt),
    index('outbound_requests_allocation_run_idx').on(table.allocationRunId),
    check('outbound_requests_number_not_blank', sql`length(btrim(${table.requestNumber})) > 0`),
    check('outbound_requests_version_nonnegative', sql`${table.version} >= 0`),
  ],
);

export const outboundRequestLines = pgTable(
  'outbound_request_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    outboundRequestId: uuid('outbound_request_id')
      .notNull()
      .references(() => outboundRequests.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    allocationLineId: uuid('allocation_line_id').references(() => allocationLines.id, {
      onDelete: 'restrict',
    }),
    requestedQuantity: integer('requested_quantity').notNull(),
    approvedQuantity: integer('approved_quantity').notNull().default(0),
    reservedQuantity: integer('reserved_quantity').notNull().default(0),
    dispatchedQuantity: integer('dispatched_quantity').notNull().default(0),
    receivedQuantity: integer('received_quantity').notNull().default(0),
    shortageReason: text('shortage_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('outbound_request_lines_request_product_uidx').on(
      table.outboundRequestId,
      table.productId,
    ),
    uniqueIndex('outbound_request_lines_allocation_line_uidx')
      .on(table.allocationLineId)
      .where(sql`${table.allocationLineId} IS NOT NULL`),
    index('outbound_request_lines_product_idx').on(table.productId),
    check('outbound_request_lines_requested_positive', sql`${table.requestedQuantity} > 0`),
    check('outbound_request_lines_approved_nonnegative', sql`${table.approvedQuantity} >= 0`),
    check('outbound_request_lines_reserved_nonnegative', sql`${table.reservedQuantity} >= 0`),
    check('outbound_request_lines_dispatched_nonnegative', sql`${table.dispatchedQuantity} >= 0`),
    check('outbound_request_lines_received_nonnegative', sql`${table.receivedQuantity} >= 0`),
    check(
      'outbound_request_lines_approved_not_over_requested',
      sql`${table.approvedQuantity} <= ${table.requestedQuantity}`,
    ),
    check(
      'outbound_request_lines_reserved_not_over_approved',
      sql`${table.reservedQuantity} <= ${table.approvedQuantity}`,
    ),
    check(
      'outbound_request_lines_dispatched_not_over_reserved',
      sql`${table.dispatchedQuantity} <= ${table.reservedQuantity}`,
    ),
    check(
      'outbound_request_lines_received_not_over_dispatched',
      sql`${table.receivedQuantity} <= ${table.dispatchedQuantity}`,
    ),
  ],
);

export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    allocationLineId: uuid('allocation_line_id').references(() => allocationLines.id, {
      onDelete: 'restrict',
    }),
    outboundRequestLineId: uuid('outbound_request_line_id').references(
      () => outboundRequestLines.id,
      { onDelete: 'restrict' },
    ),
    quantity: integer('quantity').notNull(),
    consumedQuantity: integer('consumed_quantity').notNull().default(0),
    status: reservationStatusEnum('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('reservations_active_allocation_line_uidx')
      .on(table.allocationLineId)
      .where(
        sql`${table.allocationLineId} IS NOT NULL AND ${table.status} = 'active' AND ${table.deletedAt} IS NULL`,
      ),
    index('reservations_active_outbound_line_idx')
      .on(table.outboundRequestLineId)
      .where(
        sql`${table.outboundRequestLineId} IS NOT NULL AND ${table.status} = 'active' AND ${table.deletedAt} IS NULL`,
      ),
    index('reservations_product_status_idx').on(table.productId, table.status),
    index('reservations_store_status_idx').on(table.storeId, table.status),
    index('reservations_active_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'active' AND ${table.deletedAt} IS NULL`),
    check(
      'reservations_has_source',
      sql`num_nonnulls(${table.allocationLineId}, ${table.outboundRequestLineId}) >= 1`,
    ),
    check('reservations_quantity_positive', sql`${table.quantity} > 0`),
    check('reservations_consumed_nonnegative', sql`${table.consumedQuantity} >= 0`),
    check(
      'reservations_consumed_not_over_quantity',
      sql`${table.consumedQuantity} <= ${table.quantity}`,
    ),
  ],
);

export const receipts = pgTable(
  'receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    receiptNumber: text('receipt_number').notNull().unique(),
    supplierName: text('supplier_name'),
    status: receiptStatusEnum('status').notNull().default('draft'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    totalGoodsCostVnd: bigint('total_goods_cost_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    totalShippingCostVnd: bigint('total_shipping_cost_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    totalHandlingCostVnd: bigint('total_handling_cost_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    totalOtherCostVnd: bigint('total_other_cost_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    vatAmountVnd: bigint('vat_amount_vnd', { mode: 'bigint' }),
    vatRatePercent: integer('vat_rate_percent'),
    version: integer('version').notNull().default(0),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('receipts_status_received_idx').on(table.status, table.receivedAt),
    check('receipts_number_not_blank', sql`length(btrim(${table.receiptNumber})) > 0`),
    check('receipts_goods_cost_nonnegative', sql`${table.totalGoodsCostVnd} >= 0`),
    check('receipts_shipping_cost_nonnegative', sql`${table.totalShippingCostVnd} >= 0`),
    check('receipts_handling_cost_nonnegative', sql`${table.totalHandlingCostVnd} >= 0`),
    check('receipts_other_cost_nonnegative', sql`${table.totalOtherCostVnd} >= 0`),
    check(
      'receipts_vat_valid',
      sql`(${table.vatAmountVnd} IS NULL AND ${table.vatRatePercent} IS NULL) OR (${table.vatAmountVnd} IS NOT NULL AND ${table.vatRatePercent} IS NOT NULL AND ${table.vatAmountVnd} BETWEEN 0 AND 9007199254740991 AND ${table.vatRatePercent} = 8)`,
    ),
    check('receipts_version_nonnegative', sql`${table.version} >= 0`),
    check(
      'receipts_confirmation_timestamp',
      sql`${table.status} <> 'confirmed' OR (${table.confirmedAt} IS NOT NULL AND ${table.receivedAt} IS NOT NULL)`,
    ),
  ],
);

export const receiptItems = pgTable(
  'receipt_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    bagCount: integer('bag_count').notNull().default(0),
    totalNetWeightKg: numeric('total_net_weight_kg', { precision: 14, scale: 3 }),
    unitPriceVnd: bigint('unit_price_vnd', { mode: 'bigint' }),
    pricePerKgVnd: bigint('price_per_kg_vnd', { mode: 'bigint' }),
    goodsCostVnd: bigint('goods_cost_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('receipt_items_receipt_product_uidx').on(table.receiptId, table.productId),
    index('receipt_items_product_idx').on(table.productId),
    check('receipt_items_quantity_positive', sql`${table.quantity} > 0`),
    check('receipt_items_bag_count_nonnegative', sql`${table.bagCount} >= 0`),
    check(
      'receipt_items_weight_nonnegative',
      sql`${table.totalNetWeightKg} IS NULL OR ${table.totalNetWeightKg} >= 0`,
    ),
    check(
      'receipt_items_unit_price_nonnegative',
      sql`${table.unitPriceVnd} IS NULL OR ${table.unitPriceVnd} >= 0`,
    ),
    check(
      'receipt_items_price_per_kg_nonnegative',
      sql`${table.pricePerKgVnd} IS NULL OR ${table.pricePerKgVnd} >= 0`,
    ),
    check('receipt_items_goods_cost_nonnegative', sql`${table.goodsCostVnd} >= 0`),
  ],
);

export const receiptBagWeights = pgTable(
  'receipt_bag_weights',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    receiptItemId: uuid('receipt_item_id')
      .notNull()
      .references(() => receiptItems.id, { onDelete: 'restrict' }),
    bagNumber: integer('bag_number').notNull(),
    labelCode: text('label_code'),
    grossWeightKg: numeric('gross_weight_kg', { precision: 14, scale: 3 }),
    tareWeightKg: numeric('tare_weight_kg', { precision: 14, scale: 3 }).notNull().default('0'),
    netWeightKg: numeric('net_weight_kg', { precision: 14, scale: 3 }),
    pricePerKgVnd: bigint('price_per_kg_vnd', { mode: 'bigint' }),
    goodsCostVnd: bigint('goods_cost_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('receipt_bag_weights_item_number_uidx').on(table.receiptItemId, table.bagNumber),
    uniqueIndex('receipt_bag_weights_label_uidx')
      .on(table.labelCode)
      .where(sql`${table.labelCode} IS NOT NULL`),
    check('receipt_bag_weights_number_positive', sql`${table.bagNumber} > 0`),
    check('receipt_bag_weights_gross_positive', sql`${table.grossWeightKg} > 0`),
    check(
      'receipt_bag_weights_weight_presence',
      sql`(${table.grossWeightKg} IS NULL) = (${table.netWeightKg} IS NULL)`,
    ),
    check('receipt_bag_weights_tare_nonnegative', sql`${table.tareWeightKg} >= 0`),
    check('receipt_bag_weights_net_nonnegative', sql`${table.netWeightKg} >= 0`),
    check(
      'receipt_bag_weights_weight_consistent',
      sql`${table.netWeightKg} = ${table.grossWeightKg} - ${table.tareWeightKg}`,
    ),
    check(
      'receipt_bag_weights_price_nonnegative',
      sql`${table.pricePerKgVnd} IS NULL OR ${table.pricePerKgVnd} >= 0`,
    ),
    check('receipt_bag_weights_cost_nonnegative', sql`${table.goodsCostVnd} >= 0`),
  ],
);

export const receiptCosts = pgTable(
  'receipt_costs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'restrict' }),
    receiptItemId: uuid('receipt_item_id').references(() => receiptItems.id, {
      onDelete: 'restrict',
    }),
    receiptBagWeightId: uuid('receipt_bag_weight_id').references(() => receiptBagWeights.id, {
      onDelete: 'restrict',
    }),
    costType: receiptCostTypeEnum('cost_type').notNull(),
    amountVnd: bigint('amount_vnd', { mode: 'bigint' }).notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('receipt_costs_receipt_type_idx').on(table.receiptId, table.costType),
    check('receipt_costs_amount_nonnegative', sql`${table.amountVnd} >= 0`),
  ],
);

/** Exact source-bag lineage for a warehouse-to-store shipment line. */
export const outboundBagPicks = pgTable(
  'outbound_bag_picks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    outboundRequestLineId: uuid('outbound_request_line_id')
      .notNull()
      .references(() => outboundRequestLines.id, { onDelete: 'restrict' }),
    sourceReceiptBagWeightId: uuid('source_receipt_bag_weight_id')
      .notNull()
      .references(() => receiptBagWeights.id, { onDelete: 'restrict' }),
    weightKg: numeric('weight_kg', { precision: 14, scale: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('outbound_bag_picks_line_source_uidx').on(
      table.outboundRequestLineId,
      table.sourceReceiptBagWeightId,
    ),
    index('outbound_bag_picks_source_idx').on(table.sourceReceiptBagWeightId),
    check('outbound_bag_picks_weight_positive', sql`${table.weightKg} > 0`),
  ],
);

/** Store acknowledgement of a warehouse shipment; distinct from supplier receipts. */
export const storeReceipts = pgTable(
  'store_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    receiptNumber: text('receipt_number').notNull().unique(),
    outboundRequestId: uuid('outbound_request_id')
      .notNull()
      .references(() => outboundRequests.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    status: storeReceiptStatusEnum('status').notNull().default('draft'),
    discrepancyNote: text('discrepancy_note'),
    reviewNote: text('review_note'),
    goodsCostVnd: bigint('goods_cost_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    freightVnd: bigint('freight_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    handlingVnd: bigint('handling_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    totalCostVnd: bigint('total_cost_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    version: integer('version').notNull().default(0),
    declaredByUserId: uuid('declared_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('store_receipts_outbound_uidx')
      .on(table.outboundRequestId)
      .where(sql`${table.deletedAt} IS NULL`),
    index('store_receipts_store_status_idx').on(table.storeId, table.status, table.createdAt),
    check('store_receipts_number_not_blank', sql`length(btrim(${table.receiptNumber})) > 0`),
    check('store_receipts_goods_cost_nonnegative', sql`${table.goodsCostVnd} >= 0`),
    check('store_receipts_freight_nonnegative', sql`${table.freightVnd} >= 0`),
    check('store_receipts_handling_nonnegative', sql`${table.handlingVnd} >= 0`),
    check(
      'store_receipts_total_cost_consistent',
      sql`${table.totalCostVnd} = ${table.goodsCostVnd} + ${table.freightVnd} + ${table.handlingVnd}`,
    ),
    check('store_receipts_version_nonnegative', sql`${table.version} >= 0`),
    check(
      'store_receipts_submission_state',
      sql`${table.status} = 'draft' OR (${table.declaredByUserId} IS NOT NULL AND ${table.submittedAt} IS NOT NULL)`,
    ),
    check(
      'store_receipts_finalized_state',
      sql`${table.status} <> 'finalized' OR (${table.reviewedByUserId} IS NOT NULL AND ${table.finalizedAt} IS NOT NULL)`,
    ),
  ],
);

export const storeReceiptLines = pgTable(
  'store_receipt_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storeReceiptId: uuid('store_receipt_id')
      .notNull()
      .references(() => storeReceipts.id, { onDelete: 'restrict' }),
    outboundRequestLineId: uuid('outbound_request_line_id')
      .notNull()
      .references(() => outboundRequestLines.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    approvedQuantity: integer('approved_quantity').notNull(),
    receivedQuantity: integer('received_quantity').notNull(),
    pricePerKgVnd: bigint('price_per_kg_vnd', { mode: 'bigint' }),
    goodsCostVnd: bigint('goods_cost_vnd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    shortageReason: text('shortage_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('store_receipt_lines_receipt_product_uidx').on(
      table.storeReceiptId,
      table.productId,
    ),
    uniqueIndex('store_receipt_lines_receipt_outbound_line_uidx').on(
      table.storeReceiptId,
      table.outboundRequestLineId,
    ),
    check('store_receipt_lines_approved_positive', sql`${table.approvedQuantity} > 0`),
    check('store_receipt_lines_received_nonnegative', sql`${table.receivedQuantity} >= 0`),
    check(
      'store_receipt_lines_received_not_over_approved',
      sql`${table.receivedQuantity} <= ${table.approvedQuantity}`,
    ),
    check(
      'store_receipt_lines_price_nonnegative',
      sql`${table.pricePerKgVnd} IS NULL OR ${table.pricePerKgVnd} >= 0`,
    ),
    check('store_receipt_lines_goods_cost_nonnegative', sql`${table.goodsCostVnd} >= 0`),
  ],
);

export const storeReceiptBags = pgTable(
  'store_receipt_bags',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storeReceiptLineId: uuid('store_receipt_line_id')
      .notNull()
      .references(() => storeReceiptLines.id, { onDelete: 'restrict' }),
    bagNumber: integer('bag_number').notNull(),
    bagCode: text('bag_code').notNull().unique(),
    weightKg: numeric('weight_kg', { precision: 14, scale: 3 }).notNull(),
    pricePerKgVnd: bigint('price_per_kg_vnd', { mode: 'bigint' }).notNull(),
    goodsCostVnd: bigint('goods_cost_vnd', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('store_receipt_bags_line_number_uidx').on(
      table.storeReceiptLineId,
      table.bagNumber,
    ),
    check('store_receipt_bags_number_positive', sql`${table.bagNumber} > 0`),
    check('store_receipt_bags_code_not_blank', sql`length(btrim(${table.bagCode})) > 0`),
    check('store_receipt_bags_weight_positive', sql`${table.weightKg} > 0`),
    check('store_receipt_bags_price_nonnegative', sql`${table.pricePerKgVnd} >= 0`),
    check('store_receipt_bags_cost_nonnegative', sql`${table.goodsCostVnd} >= 0`),
  ],
);

export const storeInventoryBags = pgTable(
  'store_inventory_bags',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bagCode: text('bag_code').notNull().unique(),
    displayCode: text('display_code').notNull().default(''),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    sourceStoreReceiptBagId: uuid('source_store_receipt_bag_id').references(
      () => storeReceiptBags.id,
      { onDelete: 'restrict' },
    ),
    /** Set only for stock created by a received store-to-store transfer. */
    sourceTransferId: uuid('source_transfer_id'),
    /** Physical parent bag retained for transfer provenance. */
    // The migration enforces the self-reference FK. Keeping this as a plain UUID avoids a
    // circular TypeScript initializer while retaining the database-level constraint.
    sourceInventoryBagId: uuid('source_inventory_bag_id'),
    /** Set only for stock a store received directly from a partner. */
    // The partner bag table is declared below this one, so the FK lives in the migration
    // for the same reason as the self-reference above.
    sourcePartnerInboundBagId: uuid('source_partner_inbound_bag_id'),
    outboundRequestLineId: uuid('outbound_request_line_id').references(
      () => outboundRequestLines.id,
      { onDelete: 'restrict' },
    ),
    sourceReceiptBagWeightId: uuid('source_receipt_bag_weight_id').references(
      () => receiptBagWeights.id,
      { onDelete: 'restrict' },
    ),
    status: storeInventoryBagStatusEnum('status').notNull().default('available'),
    initialWeightKg: numeric('initial_weight_kg', { precision: 14, scale: 3 }).notNull(),
    currentWeightKg: numeric('current_weight_kg', { precision: 14, scale: 3 }).notNull(),
    costVnd: bigint('cost_vnd', { mode: 'bigint' }).notNull(),
    version: integer('version').notNull().default(0),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    depletedAt: timestamp('depleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('store_inventory_bags_store_product_status_idx').on(
      table.storeId,
      table.productId,
      table.status,
    ),
    index('store_inventory_bags_outbound_line_idx').on(table.outboundRequestLineId),
    index('store_inventory_bags_source_transfer_idx').on(table.sourceTransferId),
    index('store_inventory_bags_source_inventory_bag_idx').on(table.sourceInventoryBagId),
    uniqueIndex('store_inventory_bags_store_display_code_uidx').on(
      table.storeId,
      table.displayCode,
    ),
    uniqueIndex('store_inventory_bags_store_receipt_bag_uidx').on(table.sourceStoreReceiptBagId),
    uniqueIndex('store_inventory_bags_source_transfer_uidx').on(table.sourceTransferId),
    check('store_inventory_bags_code_not_blank', sql`length(btrim(${table.bagCode})) > 0`),
    check('store_inventory_bags_display_code_format', sql`${table.displayCode} ~ '^MB-[0-9]{5,}$'`),
    check('store_inventory_bags_initial_weight_positive', sql`${table.initialWeightKg} > 0`),
    check('store_inventory_bags_current_weight_nonnegative', sql`${table.currentWeightKg} >= 0`),
    check('store_inventory_bags_cost_nonnegative', sql`${table.costVnd} >= 0`),
    check('store_inventory_bags_version_nonnegative', sql`${table.version} >= 0`),
    check(
      'store_inventory_bags_current_not_over_initial',
      sql`${table.currentWeightKg} <= ${table.initialWeightKg}`,
    ),
    uniqueIndex('store_inventory_bags_partner_inbound_bag_uidx').on(
      table.sourcePartnerInboundBagId,
    ),
    check(
      'store_inventory_bags_exactly_one_provenance',
      sql`((${table.sourceStoreReceiptBagId} IS NOT NULL)::integer + (${table.sourceTransferId} IS NOT NULL)::integer + (${table.sourcePartnerInboundBagId} IS NOT NULL)::integer) = 1`,
    ),
    check(
      'store_inventory_bags_transfer_parent',
      sql`${table.sourceTransferId} IS NULL OR ${table.sourceInventoryBagId} IS NOT NULL`,
    ),
  ],
);

/** Store-to-store movement; destination inventory is materialized only on receipt confirmation. */
export const storeTransfers = pgTable(
  'store_transfers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    transferNumber: text('transfer_number').notNull().unique(),
    sourceStoreId: uuid('source_store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    destinationStoreId: uuid('destination_store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    sourceInventoryBagId: uuid('source_inventory_bag_id')
      .notNull()
      .references(() => storeInventoryBags.id, { onDelete: 'restrict' }),
    destinationInventoryBagId: uuid('destination_inventory_bag_id').references(
      () => storeInventoryBags.id,
      { onDelete: 'restrict' },
    ),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    weightKg: numeric('weight_kg', { precision: 14, scale: 3 }).notNull(),
    costVnd: bigint('cost_vnd', { mode: 'bigint' }),
    status: storeTransferStatusEnum('status').notNull().default('draft'),
    note: text('note'),
    cancellationReason: text('cancellation_reason'),
    version: integer('version').notNull().default(0),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    dispatchedByUserId: uuid('dispatched_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    receivedByUserId: uuid('received_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('store_transfers_source_status_created_idx').on(
      table.sourceStoreId,
      table.status,
      table.createdAt,
    ),
    index('store_transfers_destination_status_created_idx').on(
      table.destinationStoreId,
      table.status,
      table.createdAt,
    ),
    index('store_transfers_product_created_idx').on(table.productId, table.createdAt),
    check('store_transfers_number_not_blank', sql`length(btrim(${table.transferNumber})) > 0`),
    check(
      'store_transfers_distinct_stores',
      sql`${table.sourceStoreId} <> ${table.destinationStoreId}`,
    ),
    check('store_transfers_weight_positive', sql`${table.weightKg} > 0`),
    check(
      'store_transfers_cost_nonnegative',
      sql`${table.costVnd} IS NULL OR ${table.costVnd} >= 0`,
    ),
    check('store_transfers_version_nonnegative', sql`${table.version} >= 0`),
    check(
      'store_transfers_dispatch_state',
      sql`${table.status} = 'draft' OR ${table.status} = 'cancelled' OR (${table.costVnd} IS NOT NULL AND ${table.dispatchedByUserId} IS NOT NULL AND ${table.dispatchedAt} IS NOT NULL)`,
    ),
    check(
      'store_transfers_receive_state',
      sql`${table.status} <> 'received' OR (${table.destinationInventoryBagId} IS NOT NULL AND ${table.receivedByUserId} IS NOT NULL AND ${table.receivedAt} IS NOT NULL)`,
    ),
    check(
      'store_transfers_cancel_state',
      sql`${table.status} <> 'cancelled' OR (${table.cancelledAt} IS NOT NULL AND length(btrim(${table.cancellationReason})) >= 3)`,
    ),
  ],
);

/** Append-only store inventory journal. Weight snapshots make every mutation auditable. */
/**
 * Goods a store receives straight from a partner, outside warehouse allocation. The slip
 * is final on save: nothing was dispatched by the warehouse, so there is no HTKD review
 * step and no dispatched quantity to reconcile against.
 */
export const storePartnerInbounds = pgTable(
  'store_partner_inbounds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    referenceCode: text('reference_code').notNull().unique(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    partnerName: text('partner_name').notNull(),
    note: text('note'),
    totalQuantity: integer('total_quantity').notNull(),
    totalWeightKg: numeric('total_weight_kg', { precision: 14, scale: 3 }).notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('store_partner_inbounds_store_received_idx').on(table.storeId, table.receivedAt),
    check(
      'store_partner_inbounds_reference_not_blank',
      sql`length(btrim(${table.referenceCode})) > 0`,
    ),
    check('store_partner_inbounds_partner_not_blank', sql`length(btrim(${table.partnerName})) > 0`),
    check('store_partner_inbounds_quantity_positive', sql`${table.totalQuantity} > 0`),
    check('store_partner_inbounds_weight_positive', sql`${table.totalWeightKg} > 0`),
  ],
);

export const storePartnerInboundLines = pgTable(
  'store_partner_inbound_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storePartnerInboundId: uuid('store_partner_inbound_id')
      .notNull()
      .references(() => storePartnerInbounds.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('store_partner_inbound_lines_slip_product_uidx').on(
      table.storePartnerInboundId,
      table.productId,
    ),
    check('store_partner_inbound_lines_quantity_positive', sql`${table.quantity} > 0`),
  ],
);

export const storePartnerInboundBags = pgTable(
  'store_partner_inbound_bags',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storePartnerInboundLineId: uuid('store_partner_inbound_line_id')
      .notNull()
      .references(() => storePartnerInboundLines.id, { onDelete: 'cascade' }),
    bagNumber: integer('bag_number').notNull(),
    bagCode: text('bag_code').notNull().unique(),
    weightKg: numeric('weight_kg', { precision: 14, scale: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('store_partner_inbound_bags_line_number_uidx').on(
      table.storePartnerInboundLineId,
      table.bagNumber,
    ),
    check('store_partner_inbound_bags_number_positive', sql`${table.bagNumber} > 0`),
    check('store_partner_inbound_bags_code_not_blank', sql`length(btrim(${table.bagCode})) > 0`),
    check('store_partner_inbound_bags_weight_positive', sql`${table.weightKg} > 0`),
  ],
);

export const storeInventoryLedgerEntries = pgTable(
  'store_inventory_ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storeInventoryBagId: uuid('store_inventory_bag_id')
      .notNull()
      .references(() => storeInventoryBags.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    eventType: storeInventoryLedgerEventTypeEnum('event_type').notNull(),
    weightBeforeKg: numeric('weight_before_kg', { precision: 14, scale: 3 }).notNull(),
    weightAfterKg: numeric('weight_after_kg', { precision: 14, scale: 3 }).notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    eventSequence: smallint('event_sequence').notNull().default(1),
    reason: text('reason').notNull(),
    metadata: jsonb('metadata').$type<JsonObject>().notNull().default({}),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('store_inventory_ledger_source_event_uidx').on(
      table.sourceType,
      table.sourceId,
      table.storeInventoryBagId,
      table.eventSequence,
    ),
    index('store_inventory_ledger_bag_occurred_idx').on(
      table.storeInventoryBagId,
      table.occurredAt,
    ),
    index('store_inventory_ledger_store_product_idx').on(table.storeId, table.productId),
    check('store_inventory_ledger_before_nonnegative', sql`${table.weightBeforeKg} >= 0`),
    check('store_inventory_ledger_after_nonnegative', sql`${table.weightAfterKg} >= 0`),
    check('store_inventory_ledger_event_sequence_positive', sql`${table.eventSequence} > 0`),
    check(
      'store_inventory_ledger_source_type_not_blank',
      sql`length(btrim(${table.sourceType})) > 0`,
    ),
    check('store_inventory_ledger_reason_not_blank', sql`length(btrim(${table.reason})) > 0`),
    check(
      'store_inventory_ledger_weight_change',
      sql`${table.eventType} IN ('quarantine', 'release') OR ${table.weightBeforeKg} <> ${table.weightAfterKg}`,
    ),
  ],
);

/** Store-side removal for sale, charity, cancellation and historical reasons. */
export const storeOutbounds = pgTable(
  'store_outbounds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    outboundNumber: text('outbound_number').notNull().unique(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    storeInventoryBagId: uuid('store_inventory_bag_id')
      .notNull()
      .references(() => storeInventoryBags.id, { onDelete: 'restrict' }),
    weightKg: numeric('weight_kg', { precision: 14, scale: 3 }).notNull(),
    reason: storeOutboundReasonEnum('reason').notNull(),
    revenueVnd: bigint('revenue_vnd', { mode: 'bigint' }),
    pieceCount: integer('piece_count'),
    status: storeOutboundStatusEnum('status').notNull().default('pending'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewNote: text('review_note'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('store_outbounds_store_status_created_idx').on(
      table.storeId,
      table.status,
      table.createdAt,
    ),
    index('store_outbounds_bag_status_idx').on(table.storeInventoryBagId, table.status),
    check('store_outbounds_number_not_blank', sql`length(btrim(${table.outboundNumber})) > 0`),
    check('store_outbounds_weight_positive', sql`${table.weightKg} > 0`),
    check(
      'store_outbounds_revenue_nonnegative',
      sql`${table.revenueVnd} IS NULL OR ${table.revenueVnd} >= 0`,
    ),
    check(
      'store_outbounds_piece_count_matches_reason',
      sql`(${table.reason} = 'sale_piece' AND ${table.pieceCount} IS NOT NULL AND ${table.pieceCount} > 0) OR (${table.reason} <> 'sale_piece' AND ${table.pieceCount} IS NULL)`,
    ),
    check('store_outbounds_version_nonnegative', sql`${table.version} >= 0`),
    check(
      'store_outbounds_review_state',
      sql`${table.status} = 'pending' OR (${table.reviewedByUserId} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL)`,
    ),
    check(
      'store_outbounds_rejection_note',
      sql`${table.status} <> 'rejected' OR length(btrim(${table.reviewNote})) >= 3`,
    ),
  ],
);

/** Append-only operational policy snapshots. The highest version is current. */
export const operationalSettingsVersions = pgTable(
  'operational_settings_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    version: integer('version').notNull(),
    timezone: text('timezone').notNull(),
    snapshotTime: time('snapshot_time', { precision: 0 }).notNull(),
    cutoffTime: time('cutoff_time', { precision: 0 }).notNull(),
    maxRequestsPerStore: integer('max_requests_per_store').notNull(),
    policyVersion: text('policy_version').notNull(),
    idosiSyncIntervalMinutes: integer('idosi_sync_interval_minutes').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    requestId: text('request_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('operational_settings_versions_version_uidx').on(table.version),
    index('operational_settings_versions_created_idx').on(table.createdAt),
    check('operational_settings_versions_version_positive', sql`${table.version} > 0`),
    check(
      'operational_settings_versions_timezone_supported',
      sql`${table.timezone} = 'Asia/Ho_Chi_Minh'`,
    ),
    check(
      'operational_settings_versions_cutoff_after_snapshot',
      sql`${table.cutoffTime} > ${table.snapshotTime}`,
    ),
    check(
      'operational_settings_versions_request_limit',
      sql`${table.maxRequestsPerStore} BETWEEN 1 AND 10`,
    ),
    check(
      'operational_settings_versions_policy_not_blank',
      sql`length(btrim(${table.policyVersion})) BETWEEN 3 AND 64`,
    ),
    check(
      'operational_settings_versions_sync_interval',
      sql`${table.idosiSyncIntervalMinutes} IN (15, 30)`,
    ),
    check(
      'operational_settings_versions_request_id_not_blank',
      sql`length(btrim(${table.requestId})) BETWEEN 1 AND 128`,
    ),
  ],
);

/** Latest validated IDOSI aggregate for one store/filter scope. It never drives inventory. */
export const idosiStatisticsSnapshots = pgTable(
  'idosi_statistics_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    scopeKey: text('scope_key').notNull(),
    period: text('period').notNull(),
    filterDate: date('filter_date'),
    shiftId: text('shift_id'),
    paymentMethod: text('payment_method'),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    sourceGeneratedAt: timestamp('source_generated_at', { withTimezone: true }).notNull(),
    sourceRequestId: text('source_request_id').notNull(),
    firstSyncedAt: timestamp('first_synced_at', { withTimezone: true }).notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull(),
    syncedByUserId: uuid('synced_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('idosi_statistics_snapshots_store_scope_uidx').on(table.storeId, table.scopeKey),
    index('idosi_statistics_snapshots_store_period_idx').on(
      table.storeId,
      table.period,
      table.lastSyncedAt,
    ),
    check(
      'idosi_statistics_snapshots_period_format',
      sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      'idosi_statistics_snapshots_scope_not_blank',
      sql`length(btrim(${table.scopeKey})) BETWEEN 1 AND 500`,
    ),
    check(
      'idosi_statistics_snapshots_shift_not_blank',
      sql`${table.shiftId} IS NULL OR length(btrim(${table.shiftId})) BETWEEN 1 AND 200`,
    ),
    check(
      'idosi_statistics_snapshots_payment_method',
      sql`${table.paymentMethod} IS NULL OR ${table.paymentMethod} IN ('cash', 'transfer')`,
    ),
    check(
      'idosi_statistics_snapshots_sync_order',
      sql`${table.lastSyncedAt} >= ${table.firstSyncedAt}`,
    ),
  ],
);

/** Completed sync attempts remain append-only evidence, including safe failure details. */
export const idosiStatisticsSyncAttempts = pgTable(
  'idosi_statistics_sync_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    snapshotId: uuid('snapshot_id').references(() => idosiStatisticsSnapshots.id, {
      onDelete: 'restrict',
    }),
    scopeKey: text('scope_key').notNull(),
    period: text('period').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    requestId: text('request_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idosi_statistics_sync_attempts_scope_completed_idx').on(
      table.storeId,
      table.scopeKey,
      table.completedAt,
    ),
    index('idosi_statistics_sync_attempts_scheduler_idx').on(
      table.period,
      table.source,
      table.completedAt,
    ),
    check(
      'idosi_statistics_sync_attempts_scope_not_blank',
      sql`length(btrim(${table.scopeKey})) BETWEEN 1 AND 500`,
    ),
    check(
      'idosi_statistics_sync_attempts_period_format',
      sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check('idosi_statistics_sync_attempts_source', sql`${table.source} IN ('manual', 'scheduled')`),
    check('idosi_statistics_sync_attempts_status', sql`${table.status} IN ('succeeded', 'failed')`),
    check(
      'idosi_statistics_sync_attempts_result',
      sql`(${table.status} = 'succeeded' AND ${table.snapshotId} IS NOT NULL AND ${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL)
        OR (${table.status} = 'failed' AND ${table.snapshotId} IS NULL AND ${table.errorCode} IS NOT NULL AND ${table.errorMessage} IS NOT NULL)`,
    ),
    check(
      'idosi_statistics_sync_attempts_time_order',
      sql`${table.completedAt} >= ${table.startedAt}`,
    ),
    check(
      'idosi_statistics_sync_attempts_request_id_not_blank',
      sql`length(btrim(${table.requestId})) BETWEEN 1 AND 128`,
    ),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: text('request_id'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorRole: userRoleEnum('actor_role'),
    actorStoreId: uuid('actor_store_id').references(() => stores.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before').$type<JsonObject>(),
    after: jsonb('after').$type<JsonObject>(),
    metadata: jsonb('metadata').$type<JsonObject>().notNull().default({}),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_entity_created_idx').on(table.entityType, table.entityId, table.createdAt),
    index('audit_logs_actor_created_idx').on(table.actorUserId, table.createdAt),
    index('audit_logs_request_idx').on(table.requestId),
    check('audit_logs_action_not_blank', sql`length(btrim(${table.action})) > 0`),
    check('audit_logs_entity_type_not_blank', sql`length(btrim(${table.entityType})) > 0`),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: idempotencyStatusEnum('status').notNull().default('in_progress'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<JsonValue>(),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idempotency_keys_scope_key_uidx').on(table.scope, table.key),
    index('idempotency_keys_expiry_idx').on(table.expiresAt),
    index('idempotency_keys_status_lock_idx').on(table.status, table.lockedUntil),
    check('idempotency_keys_scope_not_blank', sql`length(btrim(${table.scope})) > 0`),
    check('idempotency_keys_key_not_blank', sql`length(btrim(${table.key})) > 0`),
    check('idempotency_keys_hash_not_blank', sql`length(btrim(${table.requestHash})) > 0`),
    check('idempotency_keys_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'idempotency_keys_completed_response',
      sql`${table.status} <> 'completed' OR ${table.responseStatus} IS NOT NULL`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Store = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type OrderRequest = typeof orderRequests.$inferSelect;
export type NewOrderRequest = typeof orderRequests.$inferInsert;
export type OrderRequestItem = typeof orderRequestItems.$inferSelect;
export type NewOrderRequestItem = typeof orderRequestItems.$inferInsert;
export type WarehouseBalance = typeof warehouseBalances.$inferSelect;
export type WarehouseLedgerEntry = typeof warehouseLedgerEntries.$inferSelect;
export type StoreReceipt = typeof storeReceipts.$inferSelect;
export type NewStoreReceipt = typeof storeReceipts.$inferInsert;
export type StoreInventoryBag = typeof storeInventoryBags.$inferSelect;
export type StoreInventoryLedgerEntry = typeof storeInventoryLedgerEntries.$inferSelect;
export type StoreOutbound = typeof storeOutbounds.$inferSelect;
export type NewStoreOutbound = typeof storeOutbounds.$inferInsert;
export type StoreTransfer = typeof storeTransfers.$inferSelect;
export type NewStoreTransfer = typeof storeTransfers.$inferInsert;
