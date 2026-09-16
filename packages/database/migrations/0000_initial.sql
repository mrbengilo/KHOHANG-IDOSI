CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('admin', 'htkd', 'store');
CREATE TYPE user_status AS ENUM ('active', 'locked', 'disabled');
CREATE TYPE product_unit AS ENUM ('item', 'bag', 'kilogram');
CREATE TYPE order_session_status AS ENUM ('draft', 'open', 'closed', 'allocating', 'completed', 'cancelled');
CREATE TYPE order_request_status AS ENUM ('draft', 'submitted', 'merged', 'partially_allocated', 'allocated', 'waitlisted', 'cancelled');
CREATE TYPE merged_order_status AS ENUM ('pending', 'ready', 'allocated', 'cancelled');
CREATE TYPE wait_ticket_status AS ENUM ('active', 'fulfilled', 'cancelled', 'expired');
CREATE TYPE priority_level AS ENUM ('P0A', 'P0B', 'P1', 'P2', 'P3');
CREATE TYPE priority_offer_status AS ENUM ('offered', 'accepted', 'declined', 'expired', 'cancelled');
CREATE TYPE inventory_snapshot_type AS ENUM ('opening_0800', 'pre_allocation', 'manual');
CREATE TYPE inventory_snapshot_status AS ENUM ('capturing', 'completed', 'failed');
CREATE TYPE allocation_run_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');
CREATE TYPE allocation_line_status AS ENUM ('allocated', 'partial', 'waitlisted', 'skipped');
CREATE TYPE reservation_status AS ENUM ('active', 'consumed', 'released', 'expired', 'cancelled');
CREATE TYPE receipt_status AS ENUM ('draft', 'submitted', 'confirmed', 'cancelled');
CREATE TYPE receipt_cost_type AS ENUM ('goods', 'shipping', 'handling', 'other');
CREATE TYPE store_inventory_bag_status AS ENUM ('available', 'opened', 'depleted', 'returned', 'lost');
CREATE TYPE outbound_request_status AS ENUM ('draft', 'submitted', 'approved', 'reserved', 'dispatched', 'partially_received', 'received', 'completed', 'cancelled');
CREATE TYPE warehouse_ledger_event_type AS ENUM ('opening_balance', 'receipt', 'reservation', 'reservation_release', 'outbound', 'return', 'adjustment');
CREATE TYPE idempotency_status AS ENUM ('in_progress', 'completed', 'failed');

CREATE TABLE store_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT store_groups_code_not_blank CHECK (length(btrim(code)) > 0),
  CONSTRAINT store_groups_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT store_groups_display_order_nonnegative CHECK (display_order >= 0)
);

CREATE TABLE stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES store_groups(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT stores_code_not_blank CHECK (length(btrim(code)) > 0),
  CONSTRAINT stores_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT stores_display_order_nonnegative CHECK (display_order >= 0)
);
CREATE INDEX stores_group_active_idx ON stores(group_id, is_active, display_order);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID REFERENCES stores(id) ON DELETE RESTRICT,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role user_role NOT NULL,
  status user_status NOT NULL DEFAULT 'active',
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT users_email_not_blank CHECK (length(btrim(email)) > 0),
  CONSTRAINT users_password_hash_not_blank CHECK (length(password_hash) >= 20),
  CONSTRAINT users_display_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT users_token_version_nonnegative CHECK (token_version >= 0),
  CONSTRAINT users_store_scope_matches_role CHECK (
    (role = 'store' AND store_id IS NOT NULL) OR (role <> 'store' AND store_id IS NULL)
  )
);
CREATE UNIQUE INDEX users_email_lower_uidx ON users(lower(email));
CREATE INDEX users_store_status_idx ON users(store_id, status);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_token_version INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_not_blank CHECK (length(token_hash) >= 32),
  CONSTRAINT sessions_token_version_nonnegative CHECK (user_token_version >= 0),
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_active_idx ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE htkd_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT htkd_assignments_revoke_after_assignment CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);
CREATE UNIQUE INDEX htkd_assignments_active_uidx ON htkd_assignments(user_id, store_id) WHERE revoked_at IS NULL;
CREATE INDEX htkd_assignments_store_active_idx ON htkd_assignments(store_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit product_unit NOT NULL DEFAULT 'item',
  standard_bag_weight_kg NUMERIC(14,3),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT products_sku_not_blank CHECK (length(btrim(sku)) > 0),
  CONSTRAINT products_slug_not_blank CHECK (length(btrim(slug)) > 0),
  CONSTRAINT products_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT products_display_order_nonnegative CHECK (display_order >= 0),
  CONSTRAINT products_standard_bag_weight_nonnegative CHECK (standard_bag_weight_kg IS NULL OR standard_bag_weight_kg >= 0)
);
CREATE INDEX products_active_display_idx ON products(is_active, display_order);

CREATE TABLE warehouse_balances (
  product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
  on_hand_quantity INTEGER NOT NULL DEFAULT 0,
  reserved_quantity INTEGER NOT NULL DEFAULT 0,
  available_quantity INTEGER GENERATED ALWAYS AS (on_hand_quantity - reserved_quantity) STORED,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_balances_on_hand_nonnegative CHECK (on_hand_quantity >= 0),
  CONSTRAINT warehouse_balances_reserved_nonnegative CHECK (reserved_quantity >= 0),
  CONSTRAINT warehouse_balances_reserved_not_over_on_hand CHECK (reserved_quantity <= on_hand_quantity),
  CONSTRAINT warehouse_balances_version_nonnegative CHECK (version >= 0)
);

CREATE TABLE warehouse_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  event_type warehouse_ledger_event_type NOT NULL,
  on_hand_delta INTEGER NOT NULL DEFAULT 0,
  reserved_delta INTEGER NOT NULL DEFAULT 0,
  on_hand_after INTEGER NOT NULL,
  reserved_after INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  event_sequence SMALLINT NOT NULL DEFAULT 1,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_ledger_nonzero_delta CHECK (on_hand_delta <> 0 OR reserved_delta <> 0),
  CONSTRAINT warehouse_ledger_on_hand_after_nonnegative CHECK (on_hand_after >= 0),
  CONSTRAINT warehouse_ledger_reserved_after_nonnegative CHECK (reserved_after >= 0),
  CONSTRAINT warehouse_ledger_reserved_after_not_over_on_hand CHECK (reserved_after <= on_hand_after),
  CONSTRAINT warehouse_ledger_event_sequence_positive CHECK (event_sequence > 0),
  CONSTRAINT warehouse_ledger_source_type_not_blank CHECK (length(btrim(source_type)) > 0)
);
CREATE UNIQUE INDEX warehouse_ledger_source_event_uidx ON warehouse_ledger_entries(source_type, source_id, product_id, event_sequence);
CREATE INDEX warehouse_ledger_product_occurred_idx ON warehouse_ledger_entries(product_id, occurred_at);
CREATE INDEX warehouse_ledger_source_idx ON warehouse_ledger_entries(source_type, source_id);

CREATE TABLE order_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  business_date DATE NOT NULL,
  status order_session_status NOT NULL DEFAULT 'draft',
  inventory_snapshot_due_at TIMESTAMPTZ NOT NULL,
  request_deadline_at TIMESTAMPTZ NOT NULL,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  policy_version TEXT NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT order_sessions_code_not_blank CHECK (length(btrim(code)) > 0),
  CONSTRAINT order_sessions_deadline_order CHECK (request_deadline_at > inventory_snapshot_due_at),
  CONSTRAINT order_sessions_close_after_open CHECK (closed_at IS NULL OR opened_at IS NULL OR closed_at >= opened_at)
);
CREATE INDEX order_sessions_business_date_status_idx ON order_sessions(business_date, status);

CREATE TABLE order_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_session_id UUID NOT NULL REFERENCES order_sessions(id) ON DELETE RESTRICT,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  request_number SMALLINT NOT NULL,
  status order_request_status NOT NULL DEFAULT 'draft',
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT order_requests_max_two_slots CHECK (request_number BETWEEN 1 AND 2),
  CONSTRAINT order_requests_submission_timestamp CHECK (status = 'draft' OR submitted_at IS NOT NULL),
  CONSTRAINT order_requests_cancellation_timestamp CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
CREATE UNIQUE INDEX order_requests_session_store_slot_uidx ON order_requests(order_session_id, store_id, request_number);
CREATE INDEX order_requests_store_created_idx ON order_requests(store_id, created_at);
CREATE INDEX order_requests_session_status_idx ON order_requests(order_session_id, status);

CREATE TABLE order_request_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_request_id UUID NOT NULL REFERENCES order_requests(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  requested_quantity INTEGER NOT NULL,
  allocated_quantity INTEGER NOT NULL DEFAULT 0,
  waitlisted_quantity INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_request_items_requested_positive CHECK (requested_quantity > 0),
  CONSTRAINT order_request_items_allocated_nonnegative CHECK (allocated_quantity >= 0),
  CONSTRAINT order_request_items_waitlisted_nonnegative CHECK (waitlisted_quantity >= 0),
  CONSTRAINT order_request_items_resolution_not_over_requested CHECK (allocated_quantity + waitlisted_quantity <= requested_quantity)
);
CREATE UNIQUE INDEX order_request_items_request_product_uidx ON order_request_items(order_request_id, product_id);
CREATE INDEX order_request_items_product_idx ON order_request_items(product_id);

CREATE TABLE merged_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_session_id UUID NOT NULL REFERENCES order_sessions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1,
  status merged_order_status NOT NULL DEFAULT 'pending',
  request_count INTEGER NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT merged_orders_version_positive CHECK (version > 0),
  CONSTRAINT merged_orders_request_count_nonnegative CHECK (request_count >= 0)
);
CREATE UNIQUE INDEX merged_orders_session_version_uidx ON merged_orders(order_session_id, version);
CREATE INDEX merged_orders_session_status_idx ON merged_orders(order_session_id, status);

CREATE TABLE merged_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merged_order_id UUID NOT NULL REFERENCES merged_orders(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  requested_quantity INTEGER NOT NULL,
  allocated_quantity INTEGER NOT NULL DEFAULT 0,
  waitlisted_quantity INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merged_order_items_requested_nonnegative CHECK (requested_quantity >= 0),
  CONSTRAINT merged_order_items_allocated_nonnegative CHECK (allocated_quantity >= 0),
  CONSTRAINT merged_order_items_waitlisted_nonnegative CHECK (waitlisted_quantity >= 0),
  CONSTRAINT merged_order_items_resolution_not_over_requested CHECK (allocated_quantity + waitlisted_quantity <= requested_quantity)
);
CREATE UNIQUE INDEX merged_order_items_order_product_uidx ON merged_order_items(merged_order_id, product_id);
CREATE INDEX merged_order_items_product_idx ON merged_order_items(product_id);

CREATE TABLE merged_order_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merged_order_item_id UUID NOT NULL REFERENCES merged_order_items(id) ON DELETE RESTRICT,
  order_request_item_id UUID NOT NULL REFERENCES order_request_items(id) ON DELETE RESTRICT,
  requested_quantity INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merged_order_sources_quantity_positive CHECK (requested_quantity > 0)
);
CREATE UNIQUE INDEX merged_order_sources_request_item_uidx ON merged_order_sources(order_request_item_id);
CREATE INDEX merged_order_sources_merged_item_idx ON merged_order_sources(merged_order_item_id);

CREATE TABLE wait_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  source_order_request_item_id UUID REFERENCES order_request_items(id) ON DELETE RESTRICT,
  status wait_ticket_status NOT NULL DEFAULT 'active',
  priority_level priority_level NOT NULL DEFAULT 'P3',
  original_quantity INTEGER NOT NULL,
  remaining_quantity INTEGER NOT NULL,
  fulfilled_quantity INTEGER NOT NULL DEFAULT 0,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT wait_tickets_original_positive CHECK (original_quantity > 0),
  CONSTRAINT wait_tickets_remaining_nonnegative CHECK (remaining_quantity >= 0),
  CONSTRAINT wait_tickets_fulfilled_nonnegative CHECK (fulfilled_quantity >= 0),
  CONSTRAINT wait_tickets_quantity_conservation CHECK (remaining_quantity + fulfilled_quantity = original_quantity),
  CONSTRAINT wait_tickets_active_has_remaining CHECK (status <> 'active' OR remaining_quantity > 0)
);
CREATE UNIQUE INDEX wait_tickets_one_active_store_product_uidx ON wait_tickets(store_id, product_id) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX wait_tickets_active_priority_idx ON wait_tickets(product_id, priority_level, queued_at) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX wait_tickets_store_status_idx ON wait_tickets(store_id, status);

CREATE TABLE daily_priority_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date DATE NOT NULL,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  wait_ticket_id UUID REFERENCES wait_tickets(id) ON DELETE RESTRICT,
  priority_level priority_level NOT NULL,
  round_number INTEGER NOT NULL DEFAULT 1,
  offered_quantity INTEGER NOT NULL,
  accepted_quantity INTEGER NOT NULL DEFAULT 0,
  status priority_offer_status NOT NULL DEFAULT 'offered',
  response_deadline_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT daily_priority_offers_round_positive CHECK (round_number > 0),
  CONSTRAINT daily_priority_offers_quantity_positive CHECK (offered_quantity > 0),
  CONSTRAINT daily_priority_offers_accepted_nonnegative CHECK (accepted_quantity >= 0),
  CONSTRAINT daily_priority_offers_accepted_not_over_offered CHECK (accepted_quantity <= offered_quantity)
);
CREATE UNIQUE INDEX daily_priority_offers_day_store_product_round_uidx ON daily_priority_offers(business_date, store_id, product_id, round_number);
CREATE UNIQUE INDEX daily_priority_offers_one_open_uidx ON daily_priority_offers(business_date, store_id, product_id) WHERE status = 'offered' AND deleted_at IS NULL;
CREATE INDEX daily_priority_offers_deadline_idx ON daily_priority_offers(response_deadline_at) WHERE status = 'offered' AND deleted_at IS NULL;

CREATE TABLE inventory_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_session_id UUID REFERENCES order_sessions(id) ON DELETE RESTRICT,
  business_date DATE NOT NULL,
  snapshot_type inventory_snapshot_type NOT NULL,
  status inventory_snapshot_status NOT NULL DEFAULT 'capturing',
  captured_at TIMESTAMPTZ NOT NULL,
  balance_version INTEGER NOT NULL,
  captured_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_snapshots_balance_version_nonnegative CHECK (balance_version >= 0),
  CONSTRAINT inventory_snapshots_completion_timestamp CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX inventory_snapshots_session_type_uidx ON inventory_snapshots(order_session_id, snapshot_type) WHERE order_session_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX inventory_snapshots_business_date_idx ON inventory_snapshots(business_date, snapshot_type, captured_at);

CREATE TABLE inventory_snapshot_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES inventory_snapshots(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  on_hand_quantity INTEGER NOT NULL,
  reserved_quantity INTEGER NOT NULL,
  available_quantity INTEGER NOT NULL,
  warehouse_balance_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_snapshot_items_on_hand_nonnegative CHECK (on_hand_quantity >= 0),
  CONSTRAINT inventory_snapshot_items_reserved_nonnegative CHECK (reserved_quantity >= 0),
  CONSTRAINT inventory_snapshot_items_available_nonnegative CHECK (available_quantity >= 0),
  CONSTRAINT inventory_snapshot_items_quantity_consistent CHECK (available_quantity = on_hand_quantity - reserved_quantity),
  CONSTRAINT inventory_snapshot_items_balance_version_nonnegative CHECK (warehouse_balance_version >= 0)
);
CREATE UNIQUE INDEX inventory_snapshot_items_snapshot_product_uidx ON inventory_snapshot_items(snapshot_id, product_id);
CREATE INDEX inventory_snapshot_items_product_idx ON inventory_snapshot_items(product_id);

CREATE TABLE allocation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_session_id UUID NOT NULL REFERENCES order_sessions(id) ON DELETE RESTRICT,
  merged_order_id UUID NOT NULL REFERENCES merged_orders(id) ON DELETE RESTRICT,
  inventory_snapshot_id UUID NOT NULL REFERENCES inventory_snapshots(id) ON DELETE RESTRICT,
  run_number INTEGER NOT NULL,
  status allocation_run_status NOT NULL DEFAULT 'pending',
  policy_version TEXT NOT NULL,
  policy_input JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  requested_quantity INTEGER NOT NULL DEFAULT 0,
  allocated_quantity INTEGER NOT NULL DEFAULT 0,
  waitlisted_quantity INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT allocation_runs_run_number_positive CHECK (run_number > 0),
  CONSTRAINT allocation_runs_requested_nonnegative CHECK (requested_quantity >= 0),
  CONSTRAINT allocation_runs_allocated_nonnegative CHECK (allocated_quantity >= 0),
  CONSTRAINT allocation_runs_waitlisted_nonnegative CHECK (waitlisted_quantity >= 0),
  CONSTRAINT allocation_runs_resolution_not_over_requested CHECK (allocated_quantity + waitlisted_quantity <= requested_quantity),
  CONSTRAINT allocation_runs_finish_after_start CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);
CREATE UNIQUE INDEX allocation_runs_session_run_uidx ON allocation_runs(order_session_id, run_number);
CREATE UNIQUE INDEX allocation_runs_idempotency_key_uidx ON allocation_runs(idempotency_key);
CREATE INDEX allocation_runs_status_created_idx ON allocation_runs(status, created_at);

CREATE TABLE allocation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_run_id UUID NOT NULL REFERENCES allocation_runs(id) ON DELETE RESTRICT,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  order_request_item_id UUID REFERENCES order_request_items(id) ON DELETE RESTRICT,
  wait_ticket_id UUID REFERENCES wait_tickets(id) ON DELETE RESTRICT,
  priority_offer_id UUID REFERENCES daily_priority_offers(id) ON DELETE RESTRICT,
  priority_level priority_level NOT NULL,
  round_number INTEGER NOT NULL,
  sequence_in_round INTEGER NOT NULL,
  requested_quantity INTEGER NOT NULL,
  allocated_quantity INTEGER NOT NULL DEFAULT 0,
  waitlisted_quantity INTEGER NOT NULL DEFAULT 0,
  status allocation_line_status NOT NULL,
  reason_code TEXT NOT NULL,
  decision_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT allocation_lines_has_source CHECK (num_nonnulls(order_request_item_id, wait_ticket_id) >= 1),
  CONSTRAINT allocation_lines_round_positive CHECK (round_number > 0),
  CONSTRAINT allocation_lines_sequence_positive CHECK (sequence_in_round > 0),
  CONSTRAINT allocation_lines_requested_positive CHECK (requested_quantity > 0),
  CONSTRAINT allocation_lines_allocated_nonnegative CHECK (allocated_quantity >= 0),
  CONSTRAINT allocation_lines_waitlisted_nonnegative CHECK (waitlisted_quantity >= 0),
  CONSTRAINT allocation_lines_resolution_not_over_requested CHECK (allocated_quantity + waitlisted_quantity <= requested_quantity)
);
CREATE UNIQUE INDEX allocation_lines_request_round_uidx ON allocation_lines(allocation_run_id, order_request_item_id, round_number) WHERE order_request_item_id IS NOT NULL;
CREATE UNIQUE INDEX allocation_lines_wait_round_uidx ON allocation_lines(allocation_run_id, wait_ticket_id, round_number) WHERE wait_ticket_id IS NOT NULL;
CREATE INDEX allocation_lines_run_product_round_idx ON allocation_lines(allocation_run_id, product_id, round_number, sequence_in_round);
CREATE INDEX allocation_lines_store_run_idx ON allocation_lines(store_id, allocation_run_id);

CREATE TABLE outbound_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number TEXT NOT NULL UNIQUE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  order_session_id UUID REFERENCES order_sessions(id) ON DELETE RESTRICT,
  allocation_run_id UUID REFERENCES allocation_runs(id) ON DELETE RESTRICT,
  status outbound_request_status NOT NULL DEFAULT 'draft',
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  dispatched_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  received_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT outbound_requests_number_not_blank CHECK (length(btrim(request_number)) > 0)
);
CREATE INDEX outbound_requests_store_status_idx ON outbound_requests(store_id, status, created_at);
CREATE INDEX outbound_requests_allocation_run_idx ON outbound_requests(allocation_run_id);

CREATE TABLE outbound_request_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbound_request_id UUID NOT NULL REFERENCES outbound_requests(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  allocation_line_id UUID REFERENCES allocation_lines(id) ON DELETE RESTRICT,
  requested_quantity INTEGER NOT NULL,
  approved_quantity INTEGER NOT NULL DEFAULT 0,
  reserved_quantity INTEGER NOT NULL DEFAULT 0,
  dispatched_quantity INTEGER NOT NULL DEFAULT 0,
  received_quantity INTEGER NOT NULL DEFAULT 0,
  shortage_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbound_request_lines_requested_positive CHECK (requested_quantity > 0),
  CONSTRAINT outbound_request_lines_approved_nonnegative CHECK (approved_quantity >= 0),
  CONSTRAINT outbound_request_lines_reserved_nonnegative CHECK (reserved_quantity >= 0),
  CONSTRAINT outbound_request_lines_dispatched_nonnegative CHECK (dispatched_quantity >= 0),
  CONSTRAINT outbound_request_lines_received_nonnegative CHECK (received_quantity >= 0),
  CONSTRAINT outbound_request_lines_approved_not_over_requested CHECK (approved_quantity <= requested_quantity),
  CONSTRAINT outbound_request_lines_reserved_not_over_approved CHECK (reserved_quantity <= approved_quantity),
  CONSTRAINT outbound_request_lines_dispatched_not_over_reserved CHECK (dispatched_quantity <= reserved_quantity),
  CONSTRAINT outbound_request_lines_received_not_over_dispatched CHECK (received_quantity <= dispatched_quantity)
);
CREATE UNIQUE INDEX outbound_request_lines_request_product_uidx ON outbound_request_lines(outbound_request_id, product_id);
CREATE UNIQUE INDEX outbound_request_lines_allocation_line_uidx ON outbound_request_lines(allocation_line_id) WHERE allocation_line_id IS NOT NULL;
CREATE INDEX outbound_request_lines_product_idx ON outbound_request_lines(product_id);

CREATE TABLE reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  allocation_line_id UUID REFERENCES allocation_lines(id) ON DELETE RESTRICT,
  outbound_request_line_id UUID REFERENCES outbound_request_lines(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  consumed_quantity INTEGER NOT NULL DEFAULT 0,
  status reservation_status NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT reservations_has_source CHECK (num_nonnulls(allocation_line_id, outbound_request_line_id) >= 1),
  CONSTRAINT reservations_quantity_positive CHECK (quantity > 0),
  CONSTRAINT reservations_consumed_nonnegative CHECK (consumed_quantity >= 0),
  CONSTRAINT reservations_consumed_not_over_quantity CHECK (consumed_quantity <= quantity)
);
CREATE UNIQUE INDEX reservations_active_allocation_line_uidx ON reservations(allocation_line_id) WHERE allocation_line_id IS NOT NULL AND status = 'active' AND deleted_at IS NULL;
CREATE UNIQUE INDEX reservations_active_outbound_line_uidx ON reservations(outbound_request_line_id) WHERE outbound_request_line_id IS NOT NULL AND status = 'active' AND deleted_at IS NULL;
CREATE INDEX reservations_product_status_idx ON reservations(product_id, status);
CREATE INDEX reservations_store_status_idx ON reservations(store_id, status);
CREATE INDEX reservations_active_expiry_idx ON reservations(expires_at) WHERE status = 'active' AND deleted_at IS NULL;

CREATE TABLE receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number TEXT NOT NULL UNIQUE,
  supplier_name TEXT,
  status receipt_status NOT NULL DEFAULT 'draft',
  received_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  confirmed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  total_goods_cost_vnd BIGINT NOT NULL DEFAULT 0,
  total_shipping_cost_vnd BIGINT NOT NULL DEFAULT 0,
  total_handling_cost_vnd BIGINT NOT NULL DEFAULT 0,
  total_other_cost_vnd BIGINT NOT NULL DEFAULT 0,
  notes TEXT,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT receipts_number_not_blank CHECK (length(btrim(receipt_number)) > 0),
  CONSTRAINT receipts_goods_cost_nonnegative CHECK (total_goods_cost_vnd >= 0),
  CONSTRAINT receipts_shipping_cost_nonnegative CHECK (total_shipping_cost_vnd >= 0),
  CONSTRAINT receipts_handling_cost_nonnegative CHECK (total_handling_cost_vnd >= 0),
  CONSTRAINT receipts_other_cost_nonnegative CHECK (total_other_cost_vnd >= 0),
  CONSTRAINT receipts_confirmation_timestamp CHECK (status <> 'confirmed' OR (confirmed_at IS NOT NULL AND received_at IS NOT NULL))
);
CREATE INDEX receipts_status_received_idx ON receipts(status, received_at);

CREATE TABLE receipt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  bag_count INTEGER NOT NULL DEFAULT 0,
  total_net_weight_kg NUMERIC(14,3),
  unit_price_vnd BIGINT,
  price_per_kg_vnd BIGINT,
  goods_cost_vnd BIGINT NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT receipt_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT receipt_items_bag_count_nonnegative CHECK (bag_count >= 0),
  CONSTRAINT receipt_items_weight_nonnegative CHECK (total_net_weight_kg IS NULL OR total_net_weight_kg >= 0),
  CONSTRAINT receipt_items_unit_price_nonnegative CHECK (unit_price_vnd IS NULL OR unit_price_vnd >= 0),
  CONSTRAINT receipt_items_price_per_kg_nonnegative CHECK (price_per_kg_vnd IS NULL OR price_per_kg_vnd >= 0),
  CONSTRAINT receipt_items_goods_cost_nonnegative CHECK (goods_cost_vnd >= 0)
);
CREATE UNIQUE INDEX receipt_items_receipt_product_uidx ON receipt_items(receipt_id, product_id);
CREATE INDEX receipt_items_product_idx ON receipt_items(product_id);

CREATE TABLE receipt_bag_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_item_id UUID NOT NULL REFERENCES receipt_items(id) ON DELETE RESTRICT,
  bag_number INTEGER NOT NULL,
  label_code TEXT,
  gross_weight_kg NUMERIC(14,3) NOT NULL,
  tare_weight_kg NUMERIC(14,3) NOT NULL DEFAULT 0,
  net_weight_kg NUMERIC(14,3) NOT NULL,
  price_per_kg_vnd BIGINT,
  goods_cost_vnd BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT receipt_bag_weights_number_positive CHECK (bag_number > 0),
  CONSTRAINT receipt_bag_weights_gross_positive CHECK (gross_weight_kg > 0),
  CONSTRAINT receipt_bag_weights_tare_nonnegative CHECK (tare_weight_kg >= 0),
  CONSTRAINT receipt_bag_weights_net_nonnegative CHECK (net_weight_kg >= 0),
  CONSTRAINT receipt_bag_weights_weight_consistent CHECK (net_weight_kg = gross_weight_kg - tare_weight_kg),
  CONSTRAINT receipt_bag_weights_price_nonnegative CHECK (price_per_kg_vnd IS NULL OR price_per_kg_vnd >= 0),
  CONSTRAINT receipt_bag_weights_cost_nonnegative CHECK (goods_cost_vnd >= 0)
);
CREATE UNIQUE INDEX receipt_bag_weights_item_number_uidx ON receipt_bag_weights(receipt_item_id, bag_number);
CREATE UNIQUE INDEX receipt_bag_weights_label_uidx ON receipt_bag_weights(label_code) WHERE label_code IS NOT NULL;

CREATE TABLE receipt_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE RESTRICT,
  receipt_item_id UUID REFERENCES receipt_items(id) ON DELETE RESTRICT,
  receipt_bag_weight_id UUID REFERENCES receipt_bag_weights(id) ON DELETE RESTRICT,
  cost_type receipt_cost_type NOT NULL,
  amount_vnd BIGINT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT receipt_costs_amount_nonnegative CHECK (amount_vnd >= 0)
);
CREATE INDEX receipt_costs_receipt_type_idx ON receipt_costs(receipt_id, cost_type);

CREATE TABLE store_inventory_bags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bag_code TEXT NOT NULL UNIQUE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  outbound_request_line_id UUID REFERENCES outbound_request_lines(id) ON DELETE RESTRICT,
  source_receipt_bag_weight_id UUID REFERENCES receipt_bag_weights(id) ON DELETE RESTRICT,
  status store_inventory_bag_status NOT NULL DEFAULT 'available',
  initial_weight_kg NUMERIC(14,3) NOT NULL,
  current_weight_kg NUMERIC(14,3) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  opened_at TIMESTAMPTZ,
  depleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT store_inventory_bags_code_not_blank CHECK (length(btrim(bag_code)) > 0),
  CONSTRAINT store_inventory_bags_initial_weight_positive CHECK (initial_weight_kg > 0),
  CONSTRAINT store_inventory_bags_current_weight_nonnegative CHECK (current_weight_kg >= 0),
  CONSTRAINT store_inventory_bags_current_not_over_initial CHECK (current_weight_kg <= initial_weight_kg)
);
CREATE INDEX store_inventory_bags_store_product_status_idx ON store_inventory_bags(store_id, product_id, status);
CREATE INDEX store_inventory_bags_outbound_line_idx ON store_inventory_bags(outbound_request_line_id);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role user_role,
  actor_store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before JSONB,
  after JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_action_not_blank CHECK (length(btrim(action)) > 0),
  CONSTRAINT audit_logs_entity_type_not_blank CHECK (length(btrim(entity_type)) > 0)
);
CREATE INDEX audit_logs_entity_created_idx ON audit_logs(entity_type, entity_id, created_at);
CREATE INDEX audit_logs_actor_created_idx ON audit_logs(actor_user_id, created_at);
CREATE INDEX audit_logs_request_idx ON audit_logs(request_id);

CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status idempotency_status NOT NULL DEFAULT 'in_progress',
  response_status INTEGER,
  response_body JSONB,
  resource_type TEXT,
  resource_id UUID,
  locked_until TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_scope_not_blank CHECK (length(btrim(scope)) > 0),
  CONSTRAINT idempotency_keys_key_not_blank CHECK (length(btrim(key)) > 0),
  CONSTRAINT idempotency_keys_hash_not_blank CHECK (length(btrim(request_hash)) > 0),
  CONSTRAINT idempotency_keys_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT idempotency_keys_completed_response CHECK (status <> 'completed' OR response_status IS NOT NULL)
);
CREATE UNIQUE INDEX idempotency_keys_scope_key_uidx ON idempotency_keys(scope, key);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);
CREATE INDEX idempotency_keys_status_lock_idx ON idempotency_keys(status, locked_until);

-- updated_at is database-managed so every writer observes the same behavior.
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER store_groups_set_updated_at BEFORE UPDATE ON store_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stores_set_updated_at BEFORE UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER warehouse_balances_set_updated_at BEFORE UPDATE ON warehouse_balances FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER order_sessions_set_updated_at BEFORE UPDATE ON order_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER order_requests_set_updated_at BEFORE UPDATE ON order_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER order_request_items_set_updated_at BEFORE UPDATE ON order_request_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER merged_orders_set_updated_at BEFORE UPDATE ON merged_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER merged_order_items_set_updated_at BEFORE UPDATE ON merged_order_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER wait_tickets_set_updated_at BEFORE UPDATE ON wait_tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER daily_priority_offers_set_updated_at BEFORE UPDATE ON daily_priority_offers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER outbound_requests_set_updated_at BEFORE UPDATE ON outbound_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER outbound_request_lines_set_updated_at BEFORE UPDATE ON outbound_request_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER reservations_set_updated_at BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER receipts_set_updated_at BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER receipt_items_set_updated_at BEFORE UPDATE ON receipt_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER receipt_bag_weights_set_updated_at BEFORE UPDATE ON receipt_bag_weights FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER store_inventory_bags_set_updated_at BEFORE UPDATE ON store_inventory_bags FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER idempotency_keys_set_updated_at BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Ledger and audit history are append-only, including for privileged application roles.
CREATE FUNCTION prevent_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER warehouse_ledger_entries_immutable BEFORE UPDATE OR DELETE ON warehouse_ledger_entries FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();

-- Business documents are retained; cancellation/deletion must use status/deleted_at.
CREATE FUNCTION prevent_document_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hard delete is disabled for document table %; set deleted_at instead', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER order_sessions_no_hard_delete BEFORE DELETE ON order_sessions FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
CREATE TRIGGER order_requests_no_hard_delete BEFORE DELETE ON order_requests FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
CREATE TRIGGER merged_orders_no_hard_delete BEFORE DELETE ON merged_orders FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
CREATE TRIGGER wait_tickets_no_hard_delete BEFORE DELETE ON wait_tickets FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
CREATE TRIGGER daily_priority_offers_no_hard_delete BEFORE DELETE ON daily_priority_offers FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
CREATE TRIGGER inventory_snapshots_no_hard_delete BEFORE DELETE ON inventory_snapshots FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
CREATE TRIGGER allocation_runs_no_hard_delete BEFORE DELETE ON allocation_runs FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
CREATE TRIGGER reservations_no_hard_delete BEFORE DELETE ON reservations FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
CREATE TRIGGER receipts_no_hard_delete BEFORE DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
CREATE TRIGGER outbound_requests_no_hard_delete BEFORE DELETE ON outbound_requests FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();

-- Locking/disabling/re-scoping an account invalidates every outstanding session immediately.
CREATE FUNCTION revoke_sessions_on_user_security_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
    OR OLD.role IS DISTINCT FROM NEW.role
    OR OLD.store_id IS DISTINCT FROM NEW.store_id
    OR OLD.token_version IS DISTINCT FROM NEW.token_version
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
    UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, now()),
          revoke_reason = COALESCE(revoke_reason, 'user_security_changed')
      WHERE user_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_revoke_sessions_after_security_change
AFTER UPDATE OF status, role, store_id, token_version, deleted_at ON users
FOR EACH ROW EXECUTE FUNCTION revoke_sessions_on_user_security_change();
