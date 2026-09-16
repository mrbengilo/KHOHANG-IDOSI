CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."allocation_line_status" AS ENUM('allocated', 'partial', 'waitlisted', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."allocation_run_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inventory_snapshot_status" AS ENUM('capturing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inventory_snapshot_type" AS ENUM('opening_0800', 'pre_allocation', 'manual');--> statement-breakpoint
CREATE TYPE "public"."merged_order_status" AS ENUM('pending', 'ready', 'allocated', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_request_status" AS ENUM('draft', 'submitted', 'merged', 'partially_allocated', 'allocated', 'waitlisted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_session_status" AS ENUM('draft', 'open', 'closed', 'allocating', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."outbound_request_status" AS ENUM('draft', 'submitted', 'approved', 'reserved', 'dispatched', 'partially_received', 'received', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."priority_level" AS ENUM('P0A', 'P0B', 'P1', 'P2', 'P3');--> statement-breakpoint
CREATE TYPE "public"."priority_offer_status" AS ENUM('offered', 'accepted', 'declined', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."product_unit" AS ENUM('item', 'bag', 'kilogram');--> statement-breakpoint
CREATE TYPE "public"."receipt_cost_type" AS ENUM('goods', 'shipping', 'handling', 'other');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('draft', 'submitted', 'confirmed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('active', 'consumed', 'released', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."store_inventory_bag_status" AS ENUM('in_transit', 'available', 'opened', 'depleted', 'quarantined', 'returned', 'lost');--> statement-breakpoint
CREATE TYPE "public"."store_inventory_ledger_event_type" AS ENUM('receive', 'consume', 'adjust', 'quarantine', 'release');--> statement-breakpoint
CREATE TYPE "public"."store_outbound_reason" AS ENUM('discount_sale', 'charity', 'torn', 'defective', 'dirty', 'other');--> statement-breakpoint
CREATE TYPE "public"."store_outbound_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."store_receipt_status" AS ENUM('draft', 'pending_htkd', 'returned', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'htkd', 'store');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'locked', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."wait_ticket_status" AS ENUM('active', 'fulfilled', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."warehouse_ledger_event_type" AS ENUM('opening_balance', 'receipt', 'reservation', 'reservation_release', 'outbound', 'return', 'adjustment');--> statement-breakpoint
CREATE TABLE "allocation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_run_id" uuid NOT NULL,
	"merged_order_id" uuid,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"order_request_item_id" uuid,
	"wait_ticket_id" uuid,
	"priority_offer_id" uuid,
	"priority_level" "priority_level" NOT NULL,
	"round_number" integer NOT NULL,
	"sequence_in_round" integer NOT NULL,
	"requested_quantity" integer NOT NULL,
	"allocated_quantity" integer DEFAULT 0 NOT NULL,
	"waitlisted_quantity" integer DEFAULT 0 NOT NULL,
	"status" "allocation_line_status" NOT NULL,
	"reason_code" text NOT NULL,
	"decision_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_lines_exactly_one_source" CHECK (num_nonnulls("allocation_lines"."order_request_item_id", "allocation_lines"."wait_ticket_id") = 1),
	CONSTRAINT "allocation_lines_priority_source" CHECK (("allocation_lines"."wait_ticket_id" IS NOT NULL AND "allocation_lines"."priority_level" = 'P0A') OR ("allocation_lines"."order_request_item_id" IS NOT NULL AND "allocation_lines"."priority_level" <> 'P0A')),
	CONSTRAINT "allocation_lines_order_has_merged_order" CHECK ("allocation_lines"."order_request_item_id" IS NULL OR "allocation_lines"."merged_order_id" IS NOT NULL),
	CONSTRAINT "allocation_lines_round_positive" CHECK ("allocation_lines"."round_number" > 0),
	CONSTRAINT "allocation_lines_sequence_positive" CHECK ("allocation_lines"."sequence_in_round" > 0),
	CONSTRAINT "allocation_lines_requested_positive" CHECK ("allocation_lines"."requested_quantity" > 0),
	CONSTRAINT "allocation_lines_allocated_nonnegative" CHECK ("allocation_lines"."allocated_quantity" >= 0),
	CONSTRAINT "allocation_lines_waitlisted_nonnegative" CHECK ("allocation_lines"."waitlisted_quantity" >= 0),
	CONSTRAINT "allocation_lines_resolution_not_over_requested" CHECK ("allocation_lines"."allocated_quantity" + "allocation_lines"."waitlisted_quantity" <= "allocation_lines"."requested_quantity")
);
--> statement-breakpoint
CREATE TABLE "allocation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_session_id" uuid NOT NULL,
	"merged_order_id" uuid,
	"inventory_snapshot_id" uuid NOT NULL,
	"run_number" integer NOT NULL,
	"status" "allocation_run_status" DEFAULT 'pending' NOT NULL,
	"policy_version" text NOT NULL,
	"policy_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_quantity" integer DEFAULT 0 NOT NULL,
	"allocated_quantity" integer DEFAULT 0 NOT NULL,
	"waitlisted_quantity" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failure_reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "allocation_runs_run_number_positive" CHECK ("allocation_runs"."run_number" > 0),
	CONSTRAINT "allocation_runs_requested_nonnegative" CHECK ("allocation_runs"."requested_quantity" >= 0),
	CONSTRAINT "allocation_runs_allocated_nonnegative" CHECK ("allocation_runs"."allocated_quantity" >= 0),
	CONSTRAINT "allocation_runs_waitlisted_nonnegative" CHECK ("allocation_runs"."waitlisted_quantity" >= 0),
	CONSTRAINT "allocation_runs_resolution_not_over_requested" CHECK ("allocation_runs"."allocated_quantity" + "allocation_runs"."waitlisted_quantity" <= "allocation_runs"."requested_quantity"),
	CONSTRAINT "allocation_runs_finish_after_start" CHECK ("allocation_runs"."finished_at" IS NULL OR "allocation_runs"."started_at" IS NULL OR "allocation_runs"."finished_at" >= "allocation_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text,
	"actor_user_id" uuid,
	"actor_role" "user_role",
	"actor_store_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_action_not_blank" CHECK (length(btrim("audit_logs"."action")) > 0),
	CONSTRAINT "audit_logs_entity_type_not_blank" CHECK (length(btrim("audit_logs"."entity_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "daily_priority_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_date" date NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"wait_ticket_id" uuid,
	"priority_level" "priority_level" NOT NULL,
	"round_number" integer DEFAULT 1 NOT NULL,
	"offered_quantity" integer NOT NULL,
	"accepted_quantity" integer DEFAULT 0 NOT NULL,
	"status" "priority_offer_status" DEFAULT 'offered' NOT NULL,
	"response_deadline_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "daily_priority_offers_round_positive" CHECK ("daily_priority_offers"."round_number" > 0),
	CONSTRAINT "daily_priority_offers_quantity_positive" CHECK ("daily_priority_offers"."offered_quantity" > 0),
	CONSTRAINT "daily_priority_offers_accepted_nonnegative" CHECK ("daily_priority_offers"."accepted_quantity" >= 0),
	CONSTRAINT "daily_priority_offers_accepted_not_over_offered" CHECK ("daily_priority_offers"."accepted_quantity" <= "daily_priority_offers"."offered_quantity")
);
--> statement-breakpoint
CREATE TABLE "htkd_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"assigned_by_user_id" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	CONSTRAINT "htkd_assignments_revoke_after_assignment" CHECK ("htkd_assignments"."revoked_at" IS NULL OR "htkd_assignments"."revoked_at" >= "htkd_assignments"."assigned_at")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"resource_type" text,
	"resource_id" uuid,
	"locked_until" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_not_blank" CHECK (length(btrim("idempotency_keys"."scope")) > 0),
	CONSTRAINT "idempotency_keys_key_not_blank" CHECK (length(btrim("idempotency_keys"."key")) > 0),
	CONSTRAINT "idempotency_keys_hash_not_blank" CHECK (length(btrim("idempotency_keys"."request_hash")) > 0),
	CONSTRAINT "idempotency_keys_expiry_after_creation" CHECK ("idempotency_keys"."expires_at" > "idempotency_keys"."created_at"),
	CONSTRAINT "idempotency_keys_completed_response" CHECK ("idempotency_keys"."status" <> 'completed' OR "idempotency_keys"."response_status" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshot_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"on_hand_quantity" integer NOT NULL,
	"reserved_quantity" integer NOT NULL,
	"available_quantity" integer NOT NULL,
	"warehouse_balance_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_snapshot_items_on_hand_nonnegative" CHECK ("inventory_snapshot_items"."on_hand_quantity" >= 0),
	CONSTRAINT "inventory_snapshot_items_reserved_nonnegative" CHECK ("inventory_snapshot_items"."reserved_quantity" >= 0),
	CONSTRAINT "inventory_snapshot_items_available_nonnegative" CHECK ("inventory_snapshot_items"."available_quantity" >= 0),
	CONSTRAINT "inventory_snapshot_items_quantity_consistent" CHECK ("inventory_snapshot_items"."available_quantity" = "inventory_snapshot_items"."on_hand_quantity" - "inventory_snapshot_items"."reserved_quantity"),
	CONSTRAINT "inventory_snapshot_items_balance_version_nonnegative" CHECK ("inventory_snapshot_items"."warehouse_balance_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_session_id" uuid,
	"business_date" date NOT NULL,
	"snapshot_type" "inventory_snapshot_type" NOT NULL,
	"status" "inventory_snapshot_status" DEFAULT 'capturing' NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"balance_version" integer NOT NULL,
	"captured_by_user_id" uuid,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "inventory_snapshots_balance_version_nonnegative" CHECK ("inventory_snapshots"."balance_version" >= 0),
	CONSTRAINT "inventory_snapshots_completion_timestamp" CHECK ("inventory_snapshots"."status" <> 'completed' OR "inventory_snapshots"."completed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "merged_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merged_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"requested_quantity" integer NOT NULL,
	"priority_level" "priority_level" DEFAULT 'P1' NOT NULL,
	"allocated_quantity" integer DEFAULT 0 NOT NULL,
	"waitlisted_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merged_order_items_requested_positive" CHECK ("merged_order_items"."requested_quantity" > 0),
	CONSTRAINT "merged_order_items_priority_not_p0a" CHECK ("merged_order_items"."priority_level" <> 'P0A'),
	CONSTRAINT "merged_order_items_allocated_nonnegative" CHECK ("merged_order_items"."allocated_quantity" >= 0),
	CONSTRAINT "merged_order_items_waitlisted_nonnegative" CHECK ("merged_order_items"."waitlisted_quantity" >= 0),
	CONSTRAINT "merged_order_items_resolution_not_over_requested" CHECK ("merged_order_items"."allocated_quantity" + "merged_order_items"."waitlisted_quantity" <= "merged_order_items"."requested_quantity")
);
--> statement-breakpoint
CREATE TABLE "merged_order_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merged_order_item_id" uuid NOT NULL,
	"order_request_item_id" uuid NOT NULL,
	"requested_quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merged_order_sources_quantity_positive" CHECK ("merged_order_sources"."requested_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "merged_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_session_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "merged_order_status" DEFAULT 'pending' NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "merged_orders_version_positive" CHECK ("merged_orders"."version" > 0),
	CONSTRAINT "merged_orders_request_count_nonnegative" CHECK ("merged_orders"."request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_request_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_request_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"requested_quantity" integer NOT NULL,
	"priority_level" "priority_level" DEFAULT 'P1' NOT NULL,
	"allocated_quantity" integer DEFAULT 0 NOT NULL,
	"waitlisted_quantity" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_request_items_requested_positive" CHECK ("order_request_items"."requested_quantity" > 0),
	CONSTRAINT "order_request_items_priority_not_p0a" CHECK ("order_request_items"."priority_level" <> 'P0A'),
	CONSTRAINT "order_request_items_allocated_nonnegative" CHECK ("order_request_items"."allocated_quantity" >= 0),
	CONSTRAINT "order_request_items_waitlisted_nonnegative" CHECK ("order_request_items"."waitlisted_quantity" >= 0),
	CONSTRAINT "order_request_items_resolution_not_over_requested" CHECK ("order_request_items"."allocated_quantity" + "order_request_items"."waitlisted_quantity" <= "order_request_items"."requested_quantity")
);
--> statement-breakpoint
CREATE TABLE "order_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_session_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"request_number" smallint NOT NULL,
	"status" "order_request_status" DEFAULT 'draft' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "order_requests_max_two_slots" CHECK ("order_requests"."request_number" BETWEEN 1 AND 2),
	CONSTRAINT "order_requests_submission_timestamp" CHECK ("order_requests"."status" = 'draft' OR "order_requests"."submitted_at" IS NOT NULL),
	CONSTRAINT "order_requests_cancellation_timestamp" CHECK ("order_requests"."status" <> 'cancelled' OR "order_requests"."cancelled_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "order_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"business_date" date NOT NULL,
	"status" "order_session_status" DEFAULT 'draft' NOT NULL,
	"inventory_snapshot_due_at" timestamp with time zone NOT NULL,
	"request_deadline_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"policy_version" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "order_sessions_code_unique" UNIQUE("code"),
	CONSTRAINT "order_sessions_code_not_blank" CHECK (length(btrim("order_sessions"."code")) > 0),
	CONSTRAINT "order_sessions_deadline_order" CHECK ("order_sessions"."request_deadline_at" > "order_sessions"."inventory_snapshot_due_at"),
	CONSTRAINT "order_sessions_close_after_open" CHECK ("order_sessions"."closed_at" IS NULL OR "order_sessions"."opened_at" IS NULL OR "order_sessions"."closed_at" >= "order_sessions"."opened_at"),
	CONSTRAINT "order_sessions_version_nonnegative" CHECK ("order_sessions"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "outbound_bag_picks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbound_request_line_id" uuid NOT NULL,
	"source_receipt_bag_weight_id" uuid NOT NULL,
	"weight_kg" numeric(14, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_bag_picks_weight_positive" CHECK ("outbound_bag_picks"."weight_kg" > 0)
);
--> statement-breakpoint
CREATE TABLE "outbound_request_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbound_request_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"allocation_line_id" uuid,
	"requested_quantity" integer NOT NULL,
	"approved_quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"dispatched_quantity" integer DEFAULT 0 NOT NULL,
	"received_quantity" integer DEFAULT 0 NOT NULL,
	"shortage_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_request_lines_requested_positive" CHECK ("outbound_request_lines"."requested_quantity" > 0),
	CONSTRAINT "outbound_request_lines_approved_nonnegative" CHECK ("outbound_request_lines"."approved_quantity" >= 0),
	CONSTRAINT "outbound_request_lines_reserved_nonnegative" CHECK ("outbound_request_lines"."reserved_quantity" >= 0),
	CONSTRAINT "outbound_request_lines_dispatched_nonnegative" CHECK ("outbound_request_lines"."dispatched_quantity" >= 0),
	CONSTRAINT "outbound_request_lines_received_nonnegative" CHECK ("outbound_request_lines"."received_quantity" >= 0),
	CONSTRAINT "outbound_request_lines_approved_not_over_requested" CHECK ("outbound_request_lines"."approved_quantity" <= "outbound_request_lines"."requested_quantity"),
	CONSTRAINT "outbound_request_lines_reserved_not_over_approved" CHECK ("outbound_request_lines"."reserved_quantity" <= "outbound_request_lines"."approved_quantity"),
	CONSTRAINT "outbound_request_lines_dispatched_not_over_reserved" CHECK ("outbound_request_lines"."dispatched_quantity" <= "outbound_request_lines"."reserved_quantity"),
	CONSTRAINT "outbound_request_lines_received_not_over_dispatched" CHECK ("outbound_request_lines"."received_quantity" <= "outbound_request_lines"."dispatched_quantity")
);
--> statement-breakpoint
CREATE TABLE "outbound_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"order_session_id" uuid,
	"allocation_run_id" uuid,
	"status" "outbound_request_status" DEFAULT 'draft' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"dispatched_by_user_id" uuid,
	"received_by_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "outbound_requests_request_number_unique" UNIQUE("request_number"),
	CONSTRAINT "outbound_requests_number_not_blank" CHECK (length(btrim("outbound_requests"."request_number")) > 0),
	CONSTRAINT "outbound_requests_version_nonnegative" CHECK ("outbound_requests"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"unit" "product_unit" DEFAULT 'bag' NOT NULL,
	"standard_bag_weight_kg" numeric(14, 3),
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "products_sku_unique" UNIQUE("sku"),
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_sku_not_blank" CHECK (length(btrim("products"."sku")) > 0),
	CONSTRAINT "products_slug_not_blank" CHECK (length(btrim("products"."slug")) > 0),
	CONSTRAINT "products_name_not_blank" CHECK (length(btrim("products"."name")) > 0),
	CONSTRAINT "products_display_order_nonnegative" CHECK ("products"."display_order" >= 0),
	CONSTRAINT "products_version_nonnegative" CHECK ("products"."version" >= 0),
	CONSTRAINT "products_standard_bag_weight_nonnegative" CHECK ("products"."standard_bag_weight_kg" IS NULL OR "products"."standard_bag_weight_kg" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipt_bag_weights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_item_id" uuid NOT NULL,
	"bag_number" integer NOT NULL,
	"label_code" text,
	"gross_weight_kg" numeric(14, 3) NOT NULL,
	"tare_weight_kg" numeric(14, 3) DEFAULT '0' NOT NULL,
	"net_weight_kg" numeric(14, 3) NOT NULL,
	"price_per_kg_vnd" bigint,
	"goods_cost_vnd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_bag_weights_number_positive" CHECK ("receipt_bag_weights"."bag_number" > 0),
	CONSTRAINT "receipt_bag_weights_gross_positive" CHECK ("receipt_bag_weights"."gross_weight_kg" > 0),
	CONSTRAINT "receipt_bag_weights_tare_nonnegative" CHECK ("receipt_bag_weights"."tare_weight_kg" >= 0),
	CONSTRAINT "receipt_bag_weights_net_nonnegative" CHECK ("receipt_bag_weights"."net_weight_kg" >= 0),
	CONSTRAINT "receipt_bag_weights_weight_consistent" CHECK ("receipt_bag_weights"."net_weight_kg" = "receipt_bag_weights"."gross_weight_kg" - "receipt_bag_weights"."tare_weight_kg"),
	CONSTRAINT "receipt_bag_weights_price_nonnegative" CHECK ("receipt_bag_weights"."price_per_kg_vnd" IS NULL OR "receipt_bag_weights"."price_per_kg_vnd" >= 0),
	CONSTRAINT "receipt_bag_weights_cost_nonnegative" CHECK ("receipt_bag_weights"."goods_cost_vnd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipt_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"receipt_item_id" uuid,
	"receipt_bag_weight_id" uuid,
	"cost_type" "receipt_cost_type" NOT NULL,
	"amount_vnd" bigint NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_costs_amount_nonnegative" CHECK ("receipt_costs"."amount_vnd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipt_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"bag_count" integer DEFAULT 0 NOT NULL,
	"total_net_weight_kg" numeric(14, 3),
	"unit_price_vnd" bigint,
	"price_per_kg_vnd" bigint,
	"goods_cost_vnd" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_items_quantity_positive" CHECK ("receipt_items"."quantity" > 0),
	CONSTRAINT "receipt_items_bag_count_nonnegative" CHECK ("receipt_items"."bag_count" >= 0),
	CONSTRAINT "receipt_items_weight_nonnegative" CHECK ("receipt_items"."total_net_weight_kg" IS NULL OR "receipt_items"."total_net_weight_kg" >= 0),
	CONSTRAINT "receipt_items_unit_price_nonnegative" CHECK ("receipt_items"."unit_price_vnd" IS NULL OR "receipt_items"."unit_price_vnd" >= 0),
	CONSTRAINT "receipt_items_price_per_kg_nonnegative" CHECK ("receipt_items"."price_per_kg_vnd" IS NULL OR "receipt_items"."price_per_kg_vnd" >= 0),
	CONSTRAINT "receipt_items_goods_cost_nonnegative" CHECK ("receipt_items"."goods_cost_vnd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_number" text NOT NULL,
	"supplier_name" text,
	"status" "receipt_status" DEFAULT 'draft' NOT NULL,
	"received_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_user_id" uuid,
	"total_goods_cost_vnd" bigint DEFAULT 0 NOT NULL,
	"total_shipping_cost_vnd" bigint DEFAULT 0 NOT NULL,
	"total_handling_cost_vnd" bigint DEFAULT 0 NOT NULL,
	"total_other_cost_vnd" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "receipts_receipt_number_unique" UNIQUE("receipt_number"),
	CONSTRAINT "receipts_number_not_blank" CHECK (length(btrim("receipts"."receipt_number")) > 0),
	CONSTRAINT "receipts_goods_cost_nonnegative" CHECK ("receipts"."total_goods_cost_vnd" >= 0),
	CONSTRAINT "receipts_shipping_cost_nonnegative" CHECK ("receipts"."total_shipping_cost_vnd" >= 0),
	CONSTRAINT "receipts_handling_cost_nonnegative" CHECK ("receipts"."total_handling_cost_vnd" >= 0),
	CONSTRAINT "receipts_other_cost_nonnegative" CHECK ("receipts"."total_other_cost_vnd" >= 0),
	CONSTRAINT "receipts_version_nonnegative" CHECK ("receipts"."version" >= 0),
	CONSTRAINT "receipts_confirmation_timestamp" CHECK ("receipts"."status" <> 'confirmed' OR ("receipts"."confirmed_at" IS NOT NULL AND "receipts"."received_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"allocation_line_id" uuid,
	"outbound_request_line_id" uuid,
	"quantity" integer NOT NULL,
	"consumed_quantity" integer DEFAULT 0 NOT NULL,
	"status" "reservation_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "reservations_has_source" CHECK (num_nonnulls("reservations"."allocation_line_id", "reservations"."outbound_request_line_id") >= 1),
	CONSTRAINT "reservations_quantity_positive" CHECK ("reservations"."quantity" > 0),
	CONSTRAINT "reservations_consumed_nonnegative" CHECK ("reservations"."consumed_quantity" >= 0),
	CONSTRAINT "reservations_consumed_not_over_quantity" CHECK ("reservations"."consumed_quantity" <= "reservations"."quantity")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_token_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_token_hash_not_blank" CHECK (length("sessions"."token_hash") >= 32),
	CONSTRAINT "sessions_token_version_nonnegative" CHECK ("sessions"."user_token_version" >= 0),
	CONSTRAINT "sessions_expiry_after_creation" CHECK ("sessions"."expires_at" > "sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "store_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_groups_code_unique" UNIQUE("code"),
	CONSTRAINT "store_groups_code_not_blank" CHECK (length(btrim("store_groups"."code")) > 0),
	CONSTRAINT "store_groups_name_not_blank" CHECK (length(btrim("store_groups"."name")) > 0),
	CONSTRAINT "store_groups_display_order_nonnegative" CHECK ("store_groups"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "store_inventory_bags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bag_code" text NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"source_store_receipt_bag_id" uuid NOT NULL,
	"outbound_request_line_id" uuid,
	"source_receipt_bag_weight_id" uuid,
	"status" "store_inventory_bag_status" DEFAULT 'available' NOT NULL,
	"initial_weight_kg" numeric(14, 3) NOT NULL,
	"current_weight_kg" numeric(14, 3) NOT NULL,
	"cost_vnd" bigint NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"depleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_inventory_bags_bag_code_unique" UNIQUE("bag_code"),
	CONSTRAINT "store_inventory_bags_code_not_blank" CHECK (length(btrim("store_inventory_bags"."bag_code")) > 0),
	CONSTRAINT "store_inventory_bags_initial_weight_positive" CHECK ("store_inventory_bags"."initial_weight_kg" > 0),
	CONSTRAINT "store_inventory_bags_current_weight_nonnegative" CHECK ("store_inventory_bags"."current_weight_kg" >= 0),
	CONSTRAINT "store_inventory_bags_cost_nonnegative" CHECK ("store_inventory_bags"."cost_vnd" >= 0),
	CONSTRAINT "store_inventory_bags_version_nonnegative" CHECK ("store_inventory_bags"."version" >= 0),
	CONSTRAINT "store_inventory_bags_current_not_over_initial" CHECK ("store_inventory_bags"."current_weight_kg" <= "store_inventory_bags"."initial_weight_kg")
);
--> statement-breakpoint
CREATE TABLE "store_inventory_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_inventory_bag_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"event_type" "store_inventory_ledger_event_type" NOT NULL,
	"weight_before_kg" numeric(14, 3) NOT NULL,
	"weight_after_kg" numeric(14, 3) NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"event_sequence" smallint DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_inventory_ledger_before_nonnegative" CHECK ("store_inventory_ledger_entries"."weight_before_kg" >= 0),
	CONSTRAINT "store_inventory_ledger_after_nonnegative" CHECK ("store_inventory_ledger_entries"."weight_after_kg" >= 0),
	CONSTRAINT "store_inventory_ledger_event_sequence_positive" CHECK ("store_inventory_ledger_entries"."event_sequence" > 0),
	CONSTRAINT "store_inventory_ledger_source_type_not_blank" CHECK (length(btrim("store_inventory_ledger_entries"."source_type")) > 0),
	CONSTRAINT "store_inventory_ledger_reason_not_blank" CHECK (length(btrim("store_inventory_ledger_entries"."reason")) > 0),
	CONSTRAINT "store_inventory_ledger_weight_change" CHECK ("store_inventory_ledger_entries"."event_type" IN ('quarantine', 'release') OR "store_inventory_ledger_entries"."weight_before_kg" <> "store_inventory_ledger_entries"."weight_after_kg")
);
--> statement-breakpoint
CREATE TABLE "store_outbounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbound_number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"store_inventory_bag_id" uuid NOT NULL,
	"weight_kg" numeric(14, 3) NOT NULL,
	"reason" "store_outbound_reason" NOT NULL,
	"revenue_vnd" bigint,
	"status" "store_outbound_status" DEFAULT 'pending' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"reviewed_by_user_id" uuid,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "store_outbounds_outbound_number_unique" UNIQUE("outbound_number"),
	CONSTRAINT "store_outbounds_number_not_blank" CHECK (length(btrim("store_outbounds"."outbound_number")) > 0),
	CONSTRAINT "store_outbounds_weight_positive" CHECK ("store_outbounds"."weight_kg" > 0),
	CONSTRAINT "store_outbounds_revenue_nonnegative" CHECK ("store_outbounds"."revenue_vnd" IS NULL OR "store_outbounds"."revenue_vnd" >= 0),
	CONSTRAINT "store_outbounds_version_nonnegative" CHECK ("store_outbounds"."version" >= 0),
	CONSTRAINT "store_outbounds_review_state" CHECK ("store_outbounds"."status" = 'pending' OR ("store_outbounds"."reviewed_by_user_id" IS NOT NULL AND "store_outbounds"."reviewed_at" IS NOT NULL)),
	CONSTRAINT "store_outbounds_rejection_note" CHECK ("store_outbounds"."status" <> 'rejected' OR length(btrim("store_outbounds"."review_note")) >= 3)
);
--> statement-breakpoint
CREATE TABLE "store_receipt_bags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_receipt_line_id" uuid NOT NULL,
	"bag_number" integer NOT NULL,
	"bag_code" text NOT NULL,
	"weight_kg" numeric(14, 3) NOT NULL,
	"price_per_kg_vnd" bigint NOT NULL,
	"goods_cost_vnd" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_receipt_bags_bag_code_unique" UNIQUE("bag_code"),
	CONSTRAINT "store_receipt_bags_number_positive" CHECK ("store_receipt_bags"."bag_number" > 0),
	CONSTRAINT "store_receipt_bags_code_not_blank" CHECK (length(btrim("store_receipt_bags"."bag_code")) > 0),
	CONSTRAINT "store_receipt_bags_weight_positive" CHECK ("store_receipt_bags"."weight_kg" > 0),
	CONSTRAINT "store_receipt_bags_price_nonnegative" CHECK ("store_receipt_bags"."price_per_kg_vnd" >= 0),
	CONSTRAINT "store_receipt_bags_cost_nonnegative" CHECK ("store_receipt_bags"."goods_cost_vnd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "store_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_receipt_id" uuid NOT NULL,
	"outbound_request_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"approved_quantity" integer NOT NULL,
	"received_quantity" integer NOT NULL,
	"price_per_kg_vnd" bigint,
	"goods_cost_vnd" bigint DEFAULT 0 NOT NULL,
	"shortage_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_receipt_lines_approved_positive" CHECK ("store_receipt_lines"."approved_quantity" > 0),
	CONSTRAINT "store_receipt_lines_received_nonnegative" CHECK ("store_receipt_lines"."received_quantity" >= 0),
	CONSTRAINT "store_receipt_lines_received_not_over_approved" CHECK ("store_receipt_lines"."received_quantity" <= "store_receipt_lines"."approved_quantity"),
	CONSTRAINT "store_receipt_lines_price_nonnegative" CHECK ("store_receipt_lines"."price_per_kg_vnd" IS NULL OR "store_receipt_lines"."price_per_kg_vnd" >= 0),
	CONSTRAINT "store_receipt_lines_goods_cost_nonnegative" CHECK ("store_receipt_lines"."goods_cost_vnd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "store_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_number" text NOT NULL,
	"outbound_request_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "store_receipt_status" DEFAULT 'draft' NOT NULL,
	"discrepancy_note" text,
	"review_note" text,
	"goods_cost_vnd" bigint DEFAULT 0 NOT NULL,
	"freight_vnd" bigint DEFAULT 0 NOT NULL,
	"handling_vnd" bigint DEFAULT 0 NOT NULL,
	"total_cost_vnd" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"declared_by_user_id" uuid,
	"reviewed_by_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "store_receipts_receipt_number_unique" UNIQUE("receipt_number"),
	CONSTRAINT "store_receipts_number_not_blank" CHECK (length(btrim("store_receipts"."receipt_number")) > 0),
	CONSTRAINT "store_receipts_goods_cost_nonnegative" CHECK ("store_receipts"."goods_cost_vnd" >= 0),
	CONSTRAINT "store_receipts_freight_nonnegative" CHECK ("store_receipts"."freight_vnd" >= 0),
	CONSTRAINT "store_receipts_handling_nonnegative" CHECK ("store_receipts"."handling_vnd" >= 0),
	CONSTRAINT "store_receipts_total_cost_consistent" CHECK ("store_receipts"."total_cost_vnd" = "store_receipts"."goods_cost_vnd" + "store_receipts"."freight_vnd" + "store_receipts"."handling_vnd"),
	CONSTRAINT "store_receipts_version_nonnegative" CHECK ("store_receipts"."version" >= 0),
	CONSTRAINT "store_receipts_submission_state" CHECK ("store_receipts"."status" = 'draft' OR ("store_receipts"."declared_by_user_id" IS NOT NULL AND "store_receipts"."submitted_at" IS NOT NULL)),
	CONSTRAINT "store_receipts_finalized_state" CHECK ("store_receipts"."status" <> 'finalized' OR ("store_receipts"."reviewed_by_user_id" IS NOT NULL AND "store_receipts"."finalized_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"timezone" text DEFAULT 'Asia/Ho_Chi_Minh' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stores_code_unique" UNIQUE("code"),
	CONSTRAINT "stores_code_not_blank" CHECK (length(btrim("stores"."code")) > 0),
	CONSTRAINT "stores_name_not_blank" CHECK (length(btrim("stores"."name")) > 0),
	CONSTRAINT "stores_display_order_nonnegative" CHECK ("stores"."display_order" >= 0),
	CONSTRAINT "stores_version_nonnegative" CHECK ("stores"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_canonical" CHECK (length("users"."email") BETWEEN 3 AND 80 AND "users"."email" = btrim("users"."email")),
	CONSTRAINT "users_password_hash_not_blank" CHECK (length("users"."password_hash") >= 20),
	CONSTRAINT "users_display_name_not_blank" CHECK (length(btrim("users"."display_name")) > 0),
	CONSTRAINT "users_token_version_nonnegative" CHECK ("users"."token_version" >= 0),
	CONSTRAINT "users_store_scope_matches_role" CHECK (("users"."role" = 'store' AND "users"."store_id" IS NOT NULL) OR ("users"."role" <> 'store' AND "users"."store_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "wait_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"source_order_request_item_id" uuid,
	"status" "wait_ticket_status" DEFAULT 'active' NOT NULL,
	"priority_level" "priority_level" DEFAULT 'P0B' NOT NULL,
	"original_quantity" integer NOT NULL,
	"remaining_quantity" integer NOT NULL,
	"fulfilled_quantity" integer DEFAULT 0 NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "wait_tickets_original_positive" CHECK ("wait_tickets"."original_quantity" > 0),
	CONSTRAINT "wait_tickets_remaining_nonnegative" CHECK ("wait_tickets"."remaining_quantity" >= 0),
	CONSTRAINT "wait_tickets_fulfilled_nonnegative" CHECK ("wait_tickets"."fulfilled_quantity" >= 0),
	CONSTRAINT "wait_tickets_quantity_conservation" CHECK ("wait_tickets"."remaining_quantity" + "wait_tickets"."fulfilled_quantity" = "wait_tickets"."original_quantity"),
	CONSTRAINT "wait_tickets_active_has_remaining" CHECK ("wait_tickets"."status" <> 'active' OR "wait_tickets"."remaining_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "warehouse_balances" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"on_hand_quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"available_quantity" integer GENERATED ALWAYS AS ("on_hand_quantity" - "reserved_quantity") STORED NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_balances_on_hand_nonnegative" CHECK ("warehouse_balances"."on_hand_quantity" >= 0),
	CONSTRAINT "warehouse_balances_reserved_nonnegative" CHECK ("warehouse_balances"."reserved_quantity" >= 0),
	CONSTRAINT "warehouse_balances_reserved_not_over_on_hand" CHECK ("warehouse_balances"."reserved_quantity" <= "warehouse_balances"."on_hand_quantity"),
	CONSTRAINT "warehouse_balances_version_nonnegative" CHECK ("warehouse_balances"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "warehouse_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"event_type" "warehouse_ledger_event_type" NOT NULL,
	"on_hand_delta" integer DEFAULT 0 NOT NULL,
	"reserved_delta" integer DEFAULT 0 NOT NULL,
	"on_hand_after" integer NOT NULL,
	"reserved_after" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"event_sequence" smallint DEFAULT 1 NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_ledger_nonzero_delta" CHECK ("warehouse_ledger_entries"."on_hand_delta" <> 0 OR "warehouse_ledger_entries"."reserved_delta" <> 0),
	CONSTRAINT "warehouse_ledger_on_hand_after_nonnegative" CHECK ("warehouse_ledger_entries"."on_hand_after" >= 0),
	CONSTRAINT "warehouse_ledger_reserved_after_nonnegative" CHECK ("warehouse_ledger_entries"."reserved_after" >= 0),
	CONSTRAINT "warehouse_ledger_reserved_after_not_over_on_hand" CHECK ("warehouse_ledger_entries"."reserved_after" <= "warehouse_ledger_entries"."on_hand_after"),
	CONSTRAINT "warehouse_ledger_event_sequence_positive" CHECK ("warehouse_ledger_entries"."event_sequence" > 0),
	CONSTRAINT "warehouse_ledger_source_type_not_blank" CHECK (length(btrim("warehouse_ledger_entries"."source_type")) > 0)
);
--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_allocation_run_id_allocation_runs_id_fk" FOREIGN KEY ("allocation_run_id") REFERENCES "public"."allocation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_merged_order_id_merged_orders_id_fk" FOREIGN KEY ("merged_order_id") REFERENCES "public"."merged_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_order_request_item_id_order_request_items_id_fk" FOREIGN KEY ("order_request_item_id") REFERENCES "public"."order_request_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_wait_ticket_id_wait_tickets_id_fk" FOREIGN KEY ("wait_ticket_id") REFERENCES "public"."wait_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_priority_offer_id_daily_priority_offers_id_fk" FOREIGN KEY ("priority_offer_id") REFERENCES "public"."daily_priority_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_runs" ADD CONSTRAINT "allocation_runs_order_session_id_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."order_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_runs" ADD CONSTRAINT "allocation_runs_merged_order_id_merged_orders_id_fk" FOREIGN KEY ("merged_order_id") REFERENCES "public"."merged_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_runs" ADD CONSTRAINT "allocation_runs_inventory_snapshot_id_inventory_snapshots_id_fk" FOREIGN KEY ("inventory_snapshot_id") REFERENCES "public"."inventory_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_runs" ADD CONSTRAINT "allocation_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_runs" ADD CONSTRAINT "allocation_runs_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_store_id_stores_id_fk" FOREIGN KEY ("actor_store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_priority_offers" ADD CONSTRAINT "daily_priority_offers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_priority_offers" ADD CONSTRAINT "daily_priority_offers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_priority_offers" ADD CONSTRAINT "daily_priority_offers_wait_ticket_id_wait_tickets_id_fk" FOREIGN KEY ("wait_ticket_id") REFERENCES "public"."wait_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_priority_offers" ADD CONSTRAINT "daily_priority_offers_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "htkd_assignments" ADD CONSTRAINT "htkd_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "htkd_assignments" ADD CONSTRAINT "htkd_assignments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "htkd_assignments" ADD CONSTRAINT "htkd_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "htkd_assignments" ADD CONSTRAINT "htkd_assignments_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshot_items" ADD CONSTRAINT "inventory_snapshot_items_snapshot_id_inventory_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."inventory_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshot_items" ADD CONSTRAINT "inventory_snapshot_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_order_session_id_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."order_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_captured_by_user_id_users_id_fk" FOREIGN KEY ("captured_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merged_order_items" ADD CONSTRAINT "merged_order_items_merged_order_id_merged_orders_id_fk" FOREIGN KEY ("merged_order_id") REFERENCES "public"."merged_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merged_order_items" ADD CONSTRAINT "merged_order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merged_order_sources" ADD CONSTRAINT "merged_order_sources_merged_order_item_id_merged_order_items_id_fk" FOREIGN KEY ("merged_order_item_id") REFERENCES "public"."merged_order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merged_order_sources" ADD CONSTRAINT "merged_order_sources_order_request_item_id_order_request_items_id_fk" FOREIGN KEY ("order_request_item_id") REFERENCES "public"."order_request_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merged_orders" ADD CONSTRAINT "merged_orders_order_session_id_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."order_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merged_orders" ADD CONSTRAINT "merged_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merged_orders" ADD CONSTRAINT "merged_orders_generated_by_user_id_users_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merged_orders" ADD CONSTRAINT "merged_orders_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_request_items" ADD CONSTRAINT "order_request_items_order_request_id_order_requests_id_fk" FOREIGN KEY ("order_request_id") REFERENCES "public"."order_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_request_items" ADD CONSTRAINT "order_request_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_order_session_id_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."order_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_bag_picks" ADD CONSTRAINT "outbound_bag_picks_outbound_request_line_id_outbound_request_lines_id_fk" FOREIGN KEY ("outbound_request_line_id") REFERENCES "public"."outbound_request_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_bag_picks" ADD CONSTRAINT "outbound_bag_picks_source_receipt_bag_weight_id_receipt_bag_weights_id_fk" FOREIGN KEY ("source_receipt_bag_weight_id") REFERENCES "public"."receipt_bag_weights"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_request_lines" ADD CONSTRAINT "outbound_request_lines_outbound_request_id_outbound_requests_id_fk" FOREIGN KEY ("outbound_request_id") REFERENCES "public"."outbound_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_request_lines" ADD CONSTRAINT "outbound_request_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_request_lines" ADD CONSTRAINT "outbound_request_lines_allocation_line_id_allocation_lines_id_fk" FOREIGN KEY ("allocation_line_id") REFERENCES "public"."allocation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_order_session_id_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."order_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_allocation_run_id_allocation_runs_id_fk" FOREIGN KEY ("allocation_run_id") REFERENCES "public"."allocation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_dispatched_by_user_id_users_id_fk" FOREIGN KEY ("dispatched_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_bag_weights" ADD CONSTRAINT "receipt_bag_weights_receipt_item_id_receipt_items_id_fk" FOREIGN KEY ("receipt_item_id") REFERENCES "public"."receipt_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_costs" ADD CONSTRAINT "receipt_costs_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_costs" ADD CONSTRAINT "receipt_costs_receipt_item_id_receipt_items_id_fk" FOREIGN KEY ("receipt_item_id") REFERENCES "public"."receipt_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_costs" ADD CONSTRAINT "receipt_costs_receipt_bag_weight_id_receipt_bag_weights_id_fk" FOREIGN KEY ("receipt_bag_weight_id") REFERENCES "public"."receipt_bag_weights"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_allocation_line_id_allocation_lines_id_fk" FOREIGN KEY ("allocation_line_id") REFERENCES "public"."allocation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_outbound_request_line_id_outbound_request_lines_id_fk" FOREIGN KEY ("outbound_request_line_id") REFERENCES "public"."outbound_request_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_source_store_receipt_bag_id_store_receipt_bags_id_fk" FOREIGN KEY ("source_store_receipt_bag_id") REFERENCES "public"."store_receipt_bags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_outbound_request_line_id_outbound_request_lines_id_fk" FOREIGN KEY ("outbound_request_line_id") REFERENCES "public"."outbound_request_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_source_receipt_bag_weight_id_receipt_bag_weights_id_fk" FOREIGN KEY ("source_receipt_bag_weight_id") REFERENCES "public"."receipt_bag_weights"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_ledger_entries" ADD CONSTRAINT "store_inventory_ledger_entries_store_inventory_bag_id_store_inventory_bags_id_fk" FOREIGN KEY ("store_inventory_bag_id") REFERENCES "public"."store_inventory_bags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_ledger_entries" ADD CONSTRAINT "store_inventory_ledger_entries_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_ledger_entries" ADD CONSTRAINT "store_inventory_ledger_entries_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_ledger_entries" ADD CONSTRAINT "store_inventory_ledger_entries_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_outbounds" ADD CONSTRAINT "store_outbounds_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_outbounds" ADD CONSTRAINT "store_outbounds_store_inventory_bag_id_store_inventory_bags_id_fk" FOREIGN KEY ("store_inventory_bag_id") REFERENCES "public"."store_inventory_bags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_outbounds" ADD CONSTRAINT "store_outbounds_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_outbounds" ADD CONSTRAINT "store_outbounds_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_outbounds" ADD CONSTRAINT "store_outbounds_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_bags" ADD CONSTRAINT "store_receipt_bags_store_receipt_line_id_store_receipt_lines_id_fk" FOREIGN KEY ("store_receipt_line_id") REFERENCES "public"."store_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_lines" ADD CONSTRAINT "store_receipt_lines_store_receipt_id_store_receipts_id_fk" FOREIGN KEY ("store_receipt_id") REFERENCES "public"."store_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_lines" ADD CONSTRAINT "store_receipt_lines_outbound_request_line_id_outbound_request_lines_id_fk" FOREIGN KEY ("outbound_request_line_id") REFERENCES "public"."outbound_request_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_lines" ADD CONSTRAINT "store_receipt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipts" ADD CONSTRAINT "store_receipts_outbound_request_id_outbound_requests_id_fk" FOREIGN KEY ("outbound_request_id") REFERENCES "public"."outbound_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipts" ADD CONSTRAINT "store_receipts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipts" ADD CONSTRAINT "store_receipts_declared_by_user_id_users_id_fk" FOREIGN KEY ("declared_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipts" ADD CONSTRAINT "store_receipts_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipts" ADD CONSTRAINT "store_receipts_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_group_id_store_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."store_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD CONSTRAINT "wait_tickets_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD CONSTRAINT "wait_tickets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD CONSTRAINT "wait_tickets_source_order_request_item_id_order_request_items_id_fk" FOREIGN KEY ("source_order_request_item_id") REFERENCES "public"."order_request_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD CONSTRAINT "wait_tickets_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_balances" ADD CONSTRAINT "warehouse_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_ledger_entries" ADD CONSTRAINT "warehouse_ledger_entries_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_ledger_entries" ADD CONSTRAINT "warehouse_ledger_entries_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_lines_request_round_uidx" ON "allocation_lines" USING btree ("allocation_run_id","order_request_item_id","round_number") WHERE "allocation_lines"."order_request_item_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_lines_wait_round_uidx" ON "allocation_lines" USING btree ("allocation_run_id","wait_ticket_id","round_number") WHERE "allocation_lines"."wait_ticket_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "allocation_lines_run_product_round_idx" ON "allocation_lines" USING btree ("allocation_run_id","product_id","round_number","sequence_in_round");--> statement-breakpoint
CREATE INDEX "allocation_lines_store_run_idx" ON "allocation_lines" USING btree ("store_id","allocation_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_runs_session_run_uidx" ON "allocation_runs" USING btree ("order_session_id","run_number");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_runs_idempotency_key_uidx" ON "allocation_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "allocation_runs_status_created_idx" ON "allocation_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_created_idx" ON "audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_request_idx" ON "audit_logs" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_priority_offers_day_store_product_round_uidx" ON "daily_priority_offers" USING btree ("business_date","store_id","product_id","round_number");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_priority_offers_one_open_uidx" ON "daily_priority_offers" USING btree ("business_date","store_id","product_id") WHERE "daily_priority_offers"."status" = 'offered' AND "daily_priority_offers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "daily_priority_offers_deadline_idx" ON "daily_priority_offers" USING btree ("response_deadline_at") WHERE "daily_priority_offers"."status" = 'offered' AND "daily_priority_offers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "htkd_assignments_active_uidx" ON "htkd_assignments" USING btree ("user_id","store_id") WHERE "htkd_assignments"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "htkd_assignments_store_active_idx" ON "htkd_assignments" USING btree ("store_id","user_id") WHERE "htkd_assignments"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_key_uidx" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_status_lock_idx" ON "idempotency_keys" USING btree ("status","locked_until");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_snapshot_items_snapshot_product_uidx" ON "inventory_snapshot_items" USING btree ("snapshot_id","product_id");--> statement-breakpoint
CREATE INDEX "inventory_snapshot_items_product_idx" ON "inventory_snapshot_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_snapshots_session_day_type_uidx" ON "inventory_snapshots" USING btree ("order_session_id","business_date","snapshot_type") WHERE "inventory_snapshots"."order_session_id" IS NOT NULL AND "inventory_snapshots"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "inventory_snapshots_business_date_idx" ON "inventory_snapshots" USING btree ("business_date","snapshot_type","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "merged_order_items_order_product_uidx" ON "merged_order_items" USING btree ("merged_order_id","product_id");--> statement-breakpoint
CREATE INDEX "merged_order_items_product_idx" ON "merged_order_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merged_order_sources_request_item_uidx" ON "merged_order_sources" USING btree ("order_request_item_id");--> statement-breakpoint
CREATE INDEX "merged_order_sources_merged_item_idx" ON "merged_order_sources" USING btree ("merged_order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merged_orders_session_store_version_uidx" ON "merged_orders" USING btree ("order_session_id","store_id","version");--> statement-breakpoint
CREATE INDEX "merged_orders_session_status_idx" ON "merged_orders" USING btree ("order_session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "order_request_items_request_product_uidx" ON "order_request_items" USING btree ("order_request_id","product_id");--> statement-breakpoint
CREATE INDEX "order_request_items_product_idx" ON "order_request_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_requests_session_store_slot_uidx" ON "order_requests" USING btree ("order_session_id","store_id","request_number");--> statement-breakpoint
CREATE INDEX "order_requests_store_created_idx" ON "order_requests" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "order_requests_session_status_idx" ON "order_requests" USING btree ("order_session_id","status");--> statement-breakpoint
CREATE INDEX "order_sessions_business_date_status_idx" ON "order_sessions" USING btree ("business_date","status");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_bag_picks_line_source_uidx" ON "outbound_bag_picks" USING btree ("outbound_request_line_id","source_receipt_bag_weight_id");--> statement-breakpoint
CREATE INDEX "outbound_bag_picks_source_idx" ON "outbound_bag_picks" USING btree ("source_receipt_bag_weight_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_request_lines_request_product_uidx" ON "outbound_request_lines" USING btree ("outbound_request_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_request_lines_allocation_line_uidx" ON "outbound_request_lines" USING btree ("allocation_line_id") WHERE "outbound_request_lines"."allocation_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbound_request_lines_product_idx" ON "outbound_request_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "outbound_requests_store_status_idx" ON "outbound_requests" USING btree ("store_id","status","created_at");--> statement-breakpoint
CREATE INDEX "outbound_requests_allocation_run_idx" ON "outbound_requests" USING btree ("allocation_run_id");--> statement-breakpoint
CREATE INDEX "products_active_display_idx" ON "products" USING btree ("is_active","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_bag_weights_item_number_uidx" ON "receipt_bag_weights" USING btree ("receipt_item_id","bag_number");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_bag_weights_label_uidx" ON "receipt_bag_weights" USING btree ("label_code") WHERE "receipt_bag_weights"."label_code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "receipt_costs_receipt_type_idx" ON "receipt_costs" USING btree ("receipt_id","cost_type");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_items_receipt_product_uidx" ON "receipt_items" USING btree ("receipt_id","product_id");--> statement-breakpoint
CREATE INDEX "receipt_items_product_idx" ON "receipt_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "receipts_status_received_idx" ON "receipts" USING btree ("status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_active_allocation_line_uidx" ON "reservations" USING btree ("allocation_line_id") WHERE "reservations"."allocation_line_id" IS NOT NULL AND "reservations"."status" = 'active' AND "reservations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reservations_active_outbound_line_idx" ON "reservations" USING btree ("outbound_request_line_id") WHERE "reservations"."outbound_request_line_id" IS NOT NULL AND "reservations"."status" = 'active' AND "reservations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reservations_product_status_idx" ON "reservations" USING btree ("product_id","status");--> statement-breakpoint
CREATE INDEX "reservations_store_status_idx" ON "reservations" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "reservations_active_expiry_idx" ON "reservations" USING btree ("expires_at") WHERE "reservations"."status" = 'active' AND "reservations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sessions_user_active_idx" ON "sessions" USING btree ("user_id","expires_at") WHERE "sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "store_inventory_bags_store_product_status_idx" ON "store_inventory_bags" USING btree ("store_id","product_id","status");--> statement-breakpoint
CREATE INDEX "store_inventory_bags_outbound_line_idx" ON "store_inventory_bags" USING btree ("outbound_request_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_inventory_bags_store_receipt_bag_uidx" ON "store_inventory_bags" USING btree ("source_store_receipt_bag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_inventory_ledger_source_event_uidx" ON "store_inventory_ledger_entries" USING btree ("source_type","source_id","store_inventory_bag_id","event_sequence");--> statement-breakpoint
CREATE INDEX "store_inventory_ledger_bag_occurred_idx" ON "store_inventory_ledger_entries" USING btree ("store_inventory_bag_id","occurred_at");--> statement-breakpoint
CREATE INDEX "store_inventory_ledger_store_product_idx" ON "store_inventory_ledger_entries" USING btree ("store_id","product_id");--> statement-breakpoint
CREATE INDEX "store_outbounds_store_status_created_idx" ON "store_outbounds" USING btree ("store_id","status","created_at");--> statement-breakpoint
CREATE INDEX "store_outbounds_bag_status_idx" ON "store_outbounds" USING btree ("store_inventory_bag_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "store_receipt_bags_line_number_uidx" ON "store_receipt_bags" USING btree ("store_receipt_line_id","bag_number");--> statement-breakpoint
CREATE UNIQUE INDEX "store_receipt_lines_receipt_product_uidx" ON "store_receipt_lines" USING btree ("store_receipt_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_receipt_lines_receipt_outbound_line_uidx" ON "store_receipt_lines" USING btree ("store_receipt_id","outbound_request_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_receipts_outbound_uidx" ON "store_receipts" USING btree ("outbound_request_id") WHERE "store_receipts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "store_receipts_store_status_idx" ON "store_receipts" USING btree ("store_id","status","created_at");--> statement-breakpoint
CREATE INDEX "stores_group_active_idx" ON "stores" USING btree ("group_id","is_active","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uidx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_store_account_uidx" ON "users" USING btree ("store_id") WHERE "users"."role" = 'store' AND "users"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "users_store_status_idx" ON "users" USING btree ("store_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "wait_tickets_one_active_store_product_uidx" ON "wait_tickets" USING btree ("store_id","product_id") WHERE "wait_tickets"."status" = 'active' AND "wait_tickets"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "wait_tickets_active_priority_idx" ON "wait_tickets" USING btree ("product_id","priority_level","queued_at") WHERE "wait_tickets"."status" = 'active' AND "wait_tickets"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "wait_tickets_store_status_idx" ON "wait_tickets" USING btree ("store_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_ledger_source_event_uidx" ON "warehouse_ledger_entries" USING btree ("source_type","source_id","product_id","event_sequence");--> statement-breakpoint
CREATE INDEX "warehouse_ledger_product_occurred_idx" ON "warehouse_ledger_entries" USING btree ("product_id","occurred_at");--> statement-breakpoint
CREATE INDEX "warehouse_ledger_source_idx" ON "warehouse_ledger_entries" USING btree ("source_type","source_id");--> statement-breakpoint

-- Keep timestamps and optimistic versions consistent for every database writer.
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION set_updated_at_and_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.version = OLD.version THEN
    NEW.version := OLD.version + 1;
  ELSIF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'version for table % must advance exactly once', TG_TABLE_NAME
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER store_groups_set_updated_at BEFORE UPDATE ON store_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER order_requests_set_updated_at BEFORE UPDATE ON order_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER order_request_items_set_updated_at BEFORE UPDATE ON order_request_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER merged_orders_set_updated_at BEFORE UPDATE ON merged_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER merged_order_items_set_updated_at BEFORE UPDATE ON merged_order_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER wait_tickets_set_updated_at BEFORE UPDATE ON wait_tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER daily_priority_offers_set_updated_at BEFORE UPDATE ON daily_priority_offers FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER outbound_request_lines_set_updated_at BEFORE UPDATE ON outbound_request_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER reservations_set_updated_at BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER receipt_items_set_updated_at BEFORE UPDATE ON receipt_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER receipt_bag_weights_set_updated_at BEFORE UPDATE ON receipt_bag_weights FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER store_receipt_lines_set_updated_at BEFORE UPDATE ON store_receipt_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER idempotency_keys_set_updated_at BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

CREATE TRIGGER stores_set_updated_at_and_bump_version BEFORE UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();--> statement-breakpoint
CREATE TRIGGER products_set_updated_at_and_bump_version BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();--> statement-breakpoint
CREATE TRIGGER warehouse_balances_set_updated_at_and_bump_version BEFORE UPDATE ON warehouse_balances FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();--> statement-breakpoint
CREATE TRIGGER order_sessions_set_updated_at_and_bump_version BEFORE UPDATE ON order_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();--> statement-breakpoint
CREATE TRIGGER outbound_requests_set_updated_at_and_bump_version BEFORE UPDATE ON outbound_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();--> statement-breakpoint
CREATE TRIGGER receipts_set_updated_at_and_bump_version BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();--> statement-breakpoint
CREATE TRIGGER store_receipts_set_updated_at_and_bump_version BEFORE UPDATE ON store_receipts FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();--> statement-breakpoint
CREATE TRIGGER store_inventory_bags_set_updated_at_and_bump_version BEFORE UPDATE ON store_inventory_bags FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();--> statement-breakpoint
CREATE TRIGGER store_outbounds_set_updated_at_and_bump_version BEFORE UPDATE ON store_outbounds FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();--> statement-breakpoint

-- Ledgers and audit history are append-only.
CREATE FUNCTION prevent_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER warehouse_ledger_entries_immutable BEFORE UPDATE OR DELETE ON warehouse_ledger_entries FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();--> statement-breakpoint
CREATE TRIGGER store_inventory_ledger_entries_immutable BEFORE UPDATE OR DELETE ON store_inventory_ledger_entries FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();--> statement-breakpoint
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();--> statement-breakpoint

-- Business documents and their auditable details are never hard-deleted.
CREATE FUNCTION prevent_document_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hard delete is disabled for table %', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER htkd_assignments_no_hard_delete BEFORE DELETE ON htkd_assignments FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER order_sessions_no_hard_delete BEFORE DELETE ON order_sessions FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER order_requests_no_hard_delete BEFORE DELETE ON order_requests FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER merged_orders_no_hard_delete BEFORE DELETE ON merged_orders FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER wait_tickets_no_hard_delete BEFORE DELETE ON wait_tickets FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER daily_priority_offers_no_hard_delete BEFORE DELETE ON daily_priority_offers FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER inventory_snapshots_no_hard_delete BEFORE DELETE ON inventory_snapshots FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER allocation_runs_no_hard_delete BEFORE DELETE ON allocation_runs FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER reservations_no_hard_delete BEFORE DELETE ON reservations FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER receipts_no_hard_delete BEFORE DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER outbound_requests_no_hard_delete BEFORE DELETE ON outbound_requests FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER outbound_bag_picks_no_hard_delete BEFORE DELETE ON outbound_bag_picks FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER store_receipts_no_hard_delete BEFORE DELETE ON store_receipts FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER store_receipt_lines_no_hard_delete BEFORE DELETE ON store_receipt_lines FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER store_receipt_bags_no_hard_delete BEFORE DELETE ON store_receipt_bags FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER store_inventory_bags_no_hard_delete BEFORE DELETE ON store_inventory_bags FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint
CREATE TRIGGER store_outbounds_no_hard_delete BEFORE DELETE ON store_outbounds FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();--> statement-breakpoint

-- Any account security change advances token_version and revokes outstanding sessions.
CREATE FUNCTION bump_user_token_version_on_security_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
    OR OLD.role IS DISTINCT FROM NEW.role
    OR OLD.store_id IS DISTINCT FROM NEW.store_id
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
    IF NEW.token_version <= OLD.token_version THEN
      NEW.token_version := OLD.token_version + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER users_bump_token_version_before_security_change
BEFORE UPDATE OF status, role, store_id, deleted_at ON users
FOR EACH ROW EXECUTE FUNCTION bump_user_token_version_on_security_change();--> statement-breakpoint

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
$$;--> statement-breakpoint
CREATE TRIGGER users_revoke_sessions_after_security_change
AFTER UPDATE OF status, role, store_id, token_version, deleted_at ON users
FOR EACH ROW EXECUTE FUNCTION revoke_sessions_on_user_security_change();--> statement-breakpoint

CREATE FUNCTION enforce_active_store_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'store' AND NEW.status = 'active' AND NEW.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = NEW.store_id AND s.is_active AND s.deleted_at IS NULL
    ) THEN
    RAISE EXCEPTION 'an active store account requires an active store' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER users_require_active_store
BEFORE INSERT OR UPDATE OF role, status, store_id, deleted_at ON users
FOR EACH ROW EXECUTE FUNCTION enforce_active_store_user();--> statement-breakpoint

CREATE FUNCTION disable_store_users_on_store_deactivation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.is_active AND NOT NEW.is_active)
    OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
    UPDATE users
      SET status = 'disabled', token_version = token_version + 1
      WHERE store_id = NEW.id AND role = 'store' AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER stores_disable_users_after_deactivation
AFTER UPDATE OF is_active, deleted_at ON stores
FOR EACH ROW EXECUTE FUNCTION disable_store_users_on_store_deactivation();--> statement-breakpoint

CREATE FUNCTION revoke_htkd_sessions_on_assignment_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE users SET token_version = token_version + 1 WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER htkd_assignments_revoke_sessions
AFTER UPDATE OF revoked_at ON htkd_assignments
FOR EACH ROW EXECUTE FUNCTION revoke_htkd_sessions_on_assignment_revocation();--> statement-breakpoint

-- Serialize active-wait changes with new order items for the same store/product.
CREATE FUNCTION lock_order_item_against_active_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scoped_store_id uuid;
BEGIN
  SELECT store_id INTO scoped_store_id FROM order_requests WHERE id = NEW.order_request_id;
  IF scoped_store_id IS NULL THEN
    RAISE EXCEPTION 'order request does not exist' USING ERRCODE = '23503';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('store-product-wait:' || scoped_store_id || ':' || NEW.product_id, 0)
  );
  IF EXISTS (
    SELECT 1 FROM wait_tickets
    WHERE store_id = scoped_store_id AND product_id = NEW.product_id
      AND status = 'active' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'store already has an active wait ticket for this product'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER order_request_items_block_active_wait
BEFORE INSERT OR UPDATE OF order_request_id, product_id ON order_request_items
FOR EACH ROW EXECUTE FUNCTION lock_order_item_against_active_wait();--> statement-breakpoint

CREATE FUNCTION lock_active_wait_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND NEW.deleted_at IS NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('store-product-wait:' || NEW.store_id || ':' || NEW.product_id, 0)
    );
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER wait_tickets_lock_active_transition
BEFORE INSERT OR UPDATE OF store_id, product_id, status, deleted_at ON wait_tickets
FOR EACH ROW EXECUTE FUNCTION lock_active_wait_transition();--> statement-breakpoint

-- Preserve store/session/product provenance while merging and allocating.
CREATE FUNCTION validate_merged_order_source_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE merged_store_id uuid;
DECLARE merged_session_id uuid;
DECLARE merged_product_id uuid;
DECLARE request_store_id uuid;
DECLARE request_session_id uuid;
DECLARE request_product_id uuid;
BEGIN
  SELECT mo.store_id, mo.order_session_id, moi.product_id
    INTO merged_store_id, merged_session_id, merged_product_id
    FROM merged_order_items moi
    JOIN merged_orders mo ON mo.id = moi.merged_order_id
    WHERE moi.id = NEW.merged_order_item_id;
  SELECT r.store_id, r.order_session_id, ori.product_id
    INTO request_store_id, request_session_id, request_product_id
    FROM order_request_items ori
    JOIN order_requests r ON r.id = ori.order_request_id
    WHERE ori.id = NEW.order_request_item_id;
  IF merged_store_id IS NULL OR request_store_id IS NULL
    OR merged_store_id IS DISTINCT FROM request_store_id
    OR merged_session_id IS DISTINCT FROM request_session_id
    OR merged_product_id IS DISTINCT FROM request_product_id THEN
    RAISE EXCEPTION 'merged order source crosses store, session, or product scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER merged_order_sources_validate_scope
BEFORE INSERT OR UPDATE OF merged_order_item_id, order_request_item_id ON merged_order_sources
FOR EACH ROW EXECUTE FUNCTION validate_merged_order_source_scope();--> statement-breakpoint

CREATE FUNCTION validate_allocation_line_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_session_id uuid;
DECLARE snapshot_session_id uuid;
DECLARE snapshot_business_date date;
DECLARE source_store_id uuid;
DECLARE source_session_id uuid;
DECLARE source_product_id uuid;
BEGIN
  SELECT ar.order_session_id, s.order_session_id, s.business_date
    INTO run_session_id, snapshot_session_id, snapshot_business_date
    FROM allocation_runs ar
    JOIN inventory_snapshots s ON s.id = ar.inventory_snapshot_id
    WHERE ar.id = NEW.allocation_run_id;
  IF run_session_id IS NULL OR snapshot_session_id IS DISTINCT FROM run_session_id THEN
    RAISE EXCEPTION 'allocation run snapshot is outside its session' USING ERRCODE = '23514';
  END IF;

  IF NEW.order_request_item_id IS NOT NULL THEN
    SELECT r.store_id, r.order_session_id, ori.product_id
      INTO source_store_id, source_session_id, source_product_id
      FROM order_request_items ori
      JOIN order_requests r ON r.id = ori.order_request_id
      WHERE ori.id = NEW.order_request_item_id;
    IF source_store_id IS DISTINCT FROM NEW.store_id
      OR source_session_id IS DISTINCT FROM run_session_id
      OR source_product_id IS DISTINCT FROM NEW.product_id
      OR NOT EXISTS (
        SELECT 1 FROM merged_order_sources mos
        JOIN merged_order_items moi ON moi.id = mos.merged_order_item_id
        JOIN merged_orders mo ON mo.id = moi.merged_order_id
        WHERE mos.order_request_item_id = NEW.order_request_item_id
          AND mo.id = NEW.merged_order_id
          AND mo.store_id = NEW.store_id
          AND mo.order_session_id = run_session_id
      ) THEN
      RAISE EXCEPTION 'allocation order source crosses store, session, product, or merged order scope'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT store_id, product_id INTO source_store_id, source_product_id
      FROM wait_tickets WHERE id = NEW.wait_ticket_id;
    IF source_store_id IS DISTINCT FROM NEW.store_id
      OR source_product_id IS DISTINCT FROM NEW.product_id
      OR NEW.priority_offer_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM daily_priority_offers o
        WHERE o.id = NEW.priority_offer_id
          AND o.wait_ticket_id = NEW.wait_ticket_id
          AND o.store_id = NEW.store_id
          AND o.product_id = NEW.product_id
          AND o.business_date = snapshot_business_date
          AND o.status = 'accepted'
          AND o.accepted_quantity = NEW.requested_quantity
          AND o.deleted_at IS NULL
      ) THEN
      RAISE EXCEPTION 'P0A allocation lacks a matching accepted wait offer'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER allocation_lines_validate_scope
BEFORE INSERT OR UPDATE OF allocation_run_id, merged_order_id, store_id, product_id, order_request_item_id, wait_ticket_id, priority_offer_id ON allocation_lines
FOR EACH ROW EXECUTE FUNCTION validate_allocation_line_scope();--> statement-breakpoint

-- Store receipt rows must stay within their outbound document and can finalize only via
-- a transaction that already persisted exact bags, inventory, ledgers, and reservation settlement.
CREATE FUNCTION validate_store_receipt_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM outbound_requests o
    WHERE o.id = NEW.outbound_request_id AND o.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'store receipt crosses outbound store scope' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_receipts_validate_scope
BEFORE INSERT OR UPDATE OF outbound_request_id, store_id ON store_receipts
FOR EACH ROW EXECUTE FUNCTION validate_store_receipt_scope();--> statement-breakpoint

CREATE FUNCTION validate_store_receipt_line_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM store_receipts sr
    JOIN outbound_request_lines ol ON ol.outbound_request_id = sr.outbound_request_id
    WHERE sr.id = NEW.store_receipt_id
      AND ol.id = NEW.outbound_request_line_id
      AND ol.product_id = NEW.product_id
      AND ol.approved_quantity = NEW.approved_quantity
      AND ol.dispatched_quantity = NEW.approved_quantity
  ) THEN
    RAISE EXCEPTION 'store receipt line does not match its dispatched outbound line'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_receipt_lines_validate_scope
BEFORE INSERT OR UPDATE OF store_receipt_id, outbound_request_line_id, product_id, approved_quantity ON store_receipt_lines
FOR EACH ROW EXECUTE FUNCTION validate_store_receipt_line_scope();--> statement-breakpoint

CREATE FUNCTION prevent_finalized_store_receipt_line_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scoped_receipt_id uuid;
BEGIN
  scoped_receipt_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.store_receipt_id ELSE NEW.store_receipt_id END;
  IF EXISTS (SELECT 1 FROM store_receipts WHERE id = scoped_receipt_id AND status = 'finalized') THEN
    RAISE EXCEPTION 'finalized store receipt lines are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_receipt_lines_prevent_finalized_mutation
BEFORE INSERT OR UPDATE OR DELETE ON store_receipt_lines
FOR EACH ROW EXECUTE FUNCTION prevent_finalized_store_receipt_line_mutation();--> statement-breakpoint

CREATE FUNCTION prevent_finalized_store_receipt_bag_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scoped_line_id uuid;
BEGIN
  scoped_line_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.store_receipt_line_id ELSE NEW.store_receipt_line_id END;
  IF EXISTS (
    SELECT 1 FROM store_receipt_lines l
    JOIN store_receipts r ON r.id = l.store_receipt_id
    WHERE l.id = scoped_line_id AND r.status = 'finalized'
  ) THEN
    RAISE EXCEPTION 'finalized store receipt bags are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_receipt_bags_prevent_finalized_mutation
BEFORE INSERT OR UPDATE OR DELETE ON store_receipt_bags
FOR EACH ROW EXECUTE FUNCTION prevent_finalized_store_receipt_bag_mutation();--> statement-breakpoint

CREATE FUNCTION validate_store_receipt_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'finalized' THEN
    RAISE EXCEPTION 'a finalized store receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'finalized' AND OLD.status <> 'finalized' THEN
    IF NOT EXISTS (
      SELECT 1 FROM store_receipt_lines l WHERE l.store_receipt_id = NEW.id
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id
        AND (
          (l.received_quantity > 0 AND l.price_per_kg_vnd IS NULL)
          OR (SELECT count(*) FROM store_receipt_bags b WHERE b.store_receipt_line_id = l.id) <> l.received_quantity
          OR l.goods_cost_vnd <> COALESCE((SELECT sum(b.goods_cost_vnd) FROM store_receipt_bags b WHERE b.store_receipt_line_id = l.id), 0)
          OR EXISTS (
            SELECT 1 FROM store_receipt_bags b
            WHERE b.store_receipt_line_id = l.id
              AND (
                b.price_per_kg_vnd IS DISTINCT FROM l.price_per_kg_vnd
                OR b.goods_cost_vnd <> floor(b.weight_kg * b.price_per_kg_vnd + 0.5)::bigint
              )
          )
        )
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id
        AND l.received_quantity < l.approved_quantity
        AND (NEW.discrepancy_note IS NULL OR length(btrim(NEW.discrepancy_note)) < 3)
    ) OR NEW.goods_cost_vnd <> COALESCE(
      (SELECT sum(l.goods_cost_vnd) FROM store_receipt_lines l WHERE l.store_receipt_id = NEW.id),
      0
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      JOIN reservations r ON r.outbound_request_line_id = l.outbound_request_line_id
      WHERE l.store_receipt_id = NEW.id AND r.status = 'active' AND r.deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      JOIN outbound_request_lines ol ON ol.id = l.outbound_request_line_id
      WHERE l.store_receipt_id = NEW.id AND ol.received_quantity <> l.received_quantity
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id
        AND NOT EXISTS (
          SELECT 1 FROM warehouse_ledger_entries le
          WHERE le.source_type = 'store_receipt'
            AND le.source_id = NEW.id
            AND le.product_id = l.product_id
            AND le.on_hand_delta = -l.received_quantity
            AND le.reserved_delta = -l.approved_quantity
        )
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id
        AND l.received_quantity < l.approved_quantity
        AND NOT EXISTS (
          SELECT 1 FROM wait_tickets w
          WHERE w.store_id = NEW.store_id
            AND w.product_id = l.product_id
            AND w.status = 'active'
            AND w.deleted_at IS NULL
        )
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_bags b
      JOIN store_receipt_lines l ON l.id = b.store_receipt_line_id
      WHERE l.store_receipt_id = NEW.id
        AND NOT EXISTS (
          SELECT 1 FROM store_inventory_bags ib
          JOIN store_inventory_ledger_entries le ON le.store_inventory_bag_id = ib.id
          WHERE ib.source_store_receipt_bag_id = b.id
            AND le.source_type = 'store_receipt_bag'
            AND le.source_id = b.id
            AND le.event_type = 'receive'
        )
    ) THEN
      RAISE EXCEPTION 'store receipt finalization is incomplete or inconsistent'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_receipts_validate_finalization
BEFORE UPDATE OF status ON store_receipts
FOR EACH ROW EXECUTE FUNCTION validate_store_receipt_finalization();--> statement-breakpoint

-- Store outbounds are store-scoped and approval requires the atomic helper's ledger mutation.
CREATE FUNCTION validate_store_outbound_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM store_inventory_bags b
    WHERE b.id = NEW.store_inventory_bag_id AND b.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'store outbound crosses inventory store scope' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_outbounds_validate_scope
BEFORE INSERT OR UPDATE OF store_id, store_inventory_bag_id ON store_outbounds
FOR EACH ROW EXECUTE FUNCTION validate_store_outbound_scope();--> statement-breakpoint

CREATE FUNCTION validate_store_outbound_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a reviewed store outbound is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'approved' AND NOT EXISTS (
    SELECT 1 FROM store_inventory_ledger_entries le
    JOIN store_inventory_bags b ON b.id = le.store_inventory_bag_id
    WHERE le.source_type = 'store_outbound'
      AND le.source_id = NEW.id
      AND le.event_type = 'consume'
      AND le.store_inventory_bag_id = NEW.store_inventory_bag_id
      AND le.weight_before_kg - le.weight_after_kg = NEW.weight_kg
      AND b.current_weight_kg = le.weight_after_kg
  ) THEN
    RAISE EXCEPTION 'store outbound approval lacks its atomic inventory ledger entry'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_outbounds_validate_review
BEFORE UPDATE OF status ON store_outbounds
FOR EACH ROW EXECUTE FUNCTION validate_store_outbound_review();
