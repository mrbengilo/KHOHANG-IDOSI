CREATE TYPE "public"."receipt_adjustment_cause" AS ENUM('source_misclassification', 'warehouse_mispick');--> statement-breakpoint
CREATE TYPE "public"."receipt_adjustment_disposition" AS ENUM('keep', 'return');--> statement-breakpoint
CREATE TYPE "public"."receipt_adjustment_hold_state" AS ENUM('none', 'held', 'released', 'returning');--> statement-breakpoint
CREATE TYPE "public"."receipt_adjustment_status" AS ENUM('pending_htkd', 'needs_info', 'pending_admin', 'applied', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."store_receipt_return_status" AS ENUM('pending_handover', 'in_transit', 'received', 'disputed', 'lost', 'cancelled');--> statement-breakpoint
CREATE TABLE "receipt_shortage_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adjustment_line_id" uuid NOT NULL,
	"store_receipt_bag_id" uuid NOT NULL,
	"store_receipt_line_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"wait_ticket_id" uuid NOT NULL,
	"wait_mode" text NOT NULL,
	"source_order_request_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_shortage_entitlements_quantity" CHECK ("receipt_shortage_entitlements"."quantity" = 1),
	CONSTRAINT "receipt_shortage_entitlements_wait_mode" CHECK ("receipt_shortage_entitlements"."wait_mode" IN ('created', 'merged'))
);
--> statement-breakpoint
CREATE TABLE "store_receipt_adjustment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"store_receipt_line_id" uuid NOT NULL,
	"store_receipt_bag_id" uuid NOT NULL,
	"store_inventory_bag_id" uuid NOT NULL,
	"approved_product_id" uuid,
	"recorded_product_id" uuid NOT NULL,
	"actual_product_id" uuid NOT NULL,
	"disposition" "receipt_adjustment_disposition" NOT NULL,
	"recorded_weight_kg" numeric(14, 3) NOT NULL,
	"recorded_price_per_kg_vnd" bigint NOT NULL,
	"recorded_cost_vnd" bigint NOT NULL,
	"verified_weight_kg" numeric(14, 3),
	"verified_price_per_kg_vnd" bigint,
	"verified_cost_vnd" bigint,
	"weight_change_note" text,
	"shortage_quantity" integer DEFAULT 0 NOT NULL,
	"hold_state" "receipt_adjustment_hold_state" NOT NULL,
	"hold_previous_status" "store_inventory_bag_status",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_receipt_adjustment_lines_sku_changes" CHECK ("store_receipt_adjustment_lines"."actual_product_id" <> "store_receipt_adjustment_lines"."recorded_product_id"),
	CONSTRAINT "store_receipt_adjustment_lines_shortage" CHECK ("store_receipt_adjustment_lines"."shortage_quantity" IN (0, 1) AND ("store_receipt_adjustment_lines"."shortage_quantity" = 0 OR "store_receipt_adjustment_lines"."approved_product_id" IS NOT NULL)),
	CONSTRAINT "store_receipt_adjustment_lines_recorded_values" CHECK ("store_receipt_adjustment_lines"."recorded_weight_kg" > 0 AND "store_receipt_adjustment_lines"."recorded_price_per_kg_vnd" >= 0 AND "store_receipt_adjustment_lines"."recorded_cost_vnd" >= 0),
	CONSTRAINT "store_receipt_adjustment_lines_verified_values" CHECK (("store_receipt_adjustment_lines"."verified_weight_kg" IS NULL AND "store_receipt_adjustment_lines"."verified_price_per_kg_vnd" IS NULL AND "store_receipt_adjustment_lines"."verified_cost_vnd" IS NULL) OR ("store_receipt_adjustment_lines"."verified_weight_kg" > 0 AND "store_receipt_adjustment_lines"."verified_price_per_kg_vnd" >= 0 AND "store_receipt_adjustment_lines"."verified_cost_vnd" >= 0)),
	CONSTRAINT "store_receipt_adjustment_lines_hold_previous" CHECK (("store_receipt_adjustment_lines"."hold_state" = 'none') = ("store_receipt_adjustment_lines"."hold_previous_status" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "store_receipt_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"store_receipt_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "receipt_adjustment_status" DEFAULT 'pending_htkd' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"evidence_note" text,
	"discovered_at" timestamp with time zone NOT NULL,
	"cause" "receipt_adjustment_cause",
	"base_applied_count" integer DEFAULT 0 NOT NULL,
	"applied_sequence" integer,
	"goods_delta_vnd" bigint DEFAULT 0 NOT NULL,
	"freight_delta_vnd" bigint DEFAULT 0 NOT NULL,
	"handling_delta_vnd" bigint DEFAULT 0 NOT NULL,
	"vat_delta_vnd" bigint DEFAULT 0 NOT NULL,
	"verification" jsonb,
	"reported_by_user_id" uuid NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"verified_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"verification_note" text,
	"info_request_note" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_receipt_adjustments_code_format" CHECK ("store_receipt_adjustments"."code" ~ '^PSL-[0-9]{6}$'),
	CONSTRAINT "store_receipt_adjustments_reason_length" CHECK (length(btrim("store_receipt_adjustments"."reason")) BETWEEN 3 AND 1000),
	CONSTRAINT "store_receipt_adjustments_version_nonnegative" CHECK ("store_receipt_adjustments"."version" >= 0),
	CONSTRAINT "store_receipt_adjustments_base_nonnegative" CHECK ("store_receipt_adjustments"."base_applied_count" >= 0 AND ("store_receipt_adjustments"."applied_sequence" IS NULL OR "store_receipt_adjustments"."applied_sequence" > 0)),
	CONSTRAINT "store_receipt_adjustments_verified_state" CHECK ("store_receipt_adjustments"."status" NOT IN ('pending_admin', 'applied') OR ("store_receipt_adjustments"."verified_by_user_id" IS NOT NULL AND "store_receipt_adjustments"."verified_at" IS NOT NULL AND "store_receipt_adjustments"."verification" IS NOT NULL AND "store_receipt_adjustments"."cause" IS NOT NULL)),
	CONSTRAINT "store_receipt_adjustments_applied_state" CHECK (("store_receipt_adjustments"."status" = 'applied') = ("store_receipt_adjustments"."applied_sequence" IS NOT NULL AND "store_receipt_adjustments"."applied_at" IS NOT NULL) AND ("store_receipt_adjustments"."status" <> 'applied' OR "store_receipt_adjustments"."decided_by_user_id" IS NOT NULL)),
	CONSTRAINT "store_receipt_adjustments_closed_state" CHECK ("store_receipt_adjustments"."status" NOT IN ('rejected', 'cancelled') OR ("store_receipt_adjustments"."decided_by_user_id" IS NOT NULL AND "store_receipt_adjustments"."decided_at" IS NOT NULL AND length(btrim(coalesce("store_receipt_adjustments"."decision_note", ''))) >= 3))
);
--> statement-breakpoint
CREATE TABLE "store_receipt_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"adjustment_line_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"store_inventory_bag_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"weight_kg" numeric(14, 3) NOT NULL,
	"cost_vnd" bigint NOT NULL,
	"status" "store_receipt_return_status" DEFAULT 'pending_handover' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"handed_over_by_user_id" uuid,
	"handed_over_at" timestamp with time zone,
	"received_by_user_id" uuid,
	"received_at" timestamp with time zone,
	"received_quantity" integer,
	"receive_note" text,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_receipt_returns_code_format" CHECK ("store_receipt_returns"."code" ~ '^PTH-[0-9]{6}$'),
	CONSTRAINT "store_receipt_returns_quantity" CHECK ("store_receipt_returns"."quantity" = 1),
	CONSTRAINT "store_receipt_returns_values" CHECK ("store_receipt_returns"."weight_kg" > 0 AND "store_receipt_returns"."cost_vnd" >= 0 AND "store_receipt_returns"."version" >= 0),
	CONSTRAINT "store_receipt_returns_reason_length" CHECK (length(btrim("store_receipt_returns"."reason")) BETWEEN 3 AND 1000),
	CONSTRAINT "store_receipt_returns_handover_state" CHECK ("store_receipt_returns"."status" IN ('pending_handover', 'cancelled') OR ("store_receipt_returns"."handed_over_by_user_id" IS NOT NULL AND "store_receipt_returns"."handed_over_at" IS NOT NULL)),
	CONSTRAINT "store_receipt_returns_receive_state" CHECK ("store_receipt_returns"."status" IN ('pending_handover', 'in_transit', 'cancelled') OR ("store_receipt_returns"."received_by_user_id" IS NOT NULL AND "store_receipt_returns"."received_at" IS NOT NULL AND "store_receipt_returns"."received_quantity" IS NOT NULL)),
	CONSTRAINT "store_receipt_returns_received_quantity" CHECK ("store_receipt_returns"."received_quantity" IS NULL OR "store_receipt_returns"."received_quantity" BETWEEN 0 AND "store_receipt_returns"."quantity"),
	CONSTRAINT "store_receipt_returns_cancel_state" CHECK ("store_receipt_returns"."status" <> 'cancelled' OR ("store_receipt_returns"."cancelled_by_user_id" IS NOT NULL AND "store_receipt_returns"."cancelled_at" IS NOT NULL AND length(btrim(coalesce("store_receipt_returns"."cancellation_reason", ''))) >= 3))
);
--> statement-breakpoint
DROP INDEX "warehouse_shortage_checks_receipt_line_uidx";--> statement-breakpoint
ALTER TABLE "warehouse_shortage_checks" ADD COLUMN "store_receipt_adjustment_line_id" uuid;--> statement-breakpoint
ALTER TABLE "receipt_shortage_entitlements" ADD CONSTRAINT "receipt_shortage_entitlements_adjustment_line_id_store_receipt_adjustment_lines_id_fk" FOREIGN KEY ("adjustment_line_id") REFERENCES "public"."store_receipt_adjustment_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_shortage_entitlements" ADD CONSTRAINT "receipt_shortage_entitlements_store_receipt_bag_id_store_receipt_bags_id_fk" FOREIGN KEY ("store_receipt_bag_id") REFERENCES "public"."store_receipt_bags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_shortage_entitlements" ADD CONSTRAINT "receipt_shortage_entitlements_store_receipt_line_id_store_receipt_lines_id_fk" FOREIGN KEY ("store_receipt_line_id") REFERENCES "public"."store_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_shortage_entitlements" ADD CONSTRAINT "receipt_shortage_entitlements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_shortage_entitlements" ADD CONSTRAINT "receipt_shortage_entitlements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_shortage_entitlements" ADD CONSTRAINT "receipt_shortage_entitlements_wait_ticket_id_wait_tickets_id_fk" FOREIGN KEY ("wait_ticket_id") REFERENCES "public"."wait_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_shortage_entitlements" ADD CONSTRAINT "receipt_shortage_entitlements_source_order_request_item_id_order_request_items_id_fk" FOREIGN KEY ("source_order_request_item_id") REFERENCES "public"."order_request_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustment_lines" ADD CONSTRAINT "store_receipt_adjustment_lines_adjustment_id_store_receipt_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."store_receipt_adjustments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustment_lines" ADD CONSTRAINT "store_receipt_adjustment_lines_store_receipt_line_id_store_receipt_lines_id_fk" FOREIGN KEY ("store_receipt_line_id") REFERENCES "public"."store_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustment_lines" ADD CONSTRAINT "store_receipt_adjustment_lines_store_receipt_bag_id_store_receipt_bags_id_fk" FOREIGN KEY ("store_receipt_bag_id") REFERENCES "public"."store_receipt_bags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustment_lines" ADD CONSTRAINT "store_receipt_adjustment_lines_store_inventory_bag_id_store_inventory_bags_id_fk" FOREIGN KEY ("store_inventory_bag_id") REFERENCES "public"."store_inventory_bags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustment_lines" ADD CONSTRAINT "store_receipt_adjustment_lines_approved_product_id_products_id_fk" FOREIGN KEY ("approved_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustment_lines" ADD CONSTRAINT "store_receipt_adjustment_lines_recorded_product_id_products_id_fk" FOREIGN KEY ("recorded_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustment_lines" ADD CONSTRAINT "store_receipt_adjustment_lines_actual_product_id_products_id_fk" FOREIGN KEY ("actual_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustments" ADD CONSTRAINT "store_receipt_adjustments_store_receipt_id_store_receipts_id_fk" FOREIGN KEY ("store_receipt_id") REFERENCES "public"."store_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustments" ADD CONSTRAINT "store_receipt_adjustments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustments" ADD CONSTRAINT "store_receipt_adjustments_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustments" ADD CONSTRAINT "store_receipt_adjustments_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_adjustments" ADD CONSTRAINT "store_receipt_adjustments_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_returns" ADD CONSTRAINT "store_receipt_returns_adjustment_line_id_store_receipt_adjustment_lines_id_fk" FOREIGN KEY ("adjustment_line_id") REFERENCES "public"."store_receipt_adjustment_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_returns" ADD CONSTRAINT "store_receipt_returns_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_returns" ADD CONSTRAINT "store_receipt_returns_store_inventory_bag_id_store_inventory_bags_id_fk" FOREIGN KEY ("store_inventory_bag_id") REFERENCES "public"."store_inventory_bags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_returns" ADD CONSTRAINT "store_receipt_returns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_returns" ADD CONSTRAINT "store_receipt_returns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_returns" ADD CONSTRAINT "store_receipt_returns_handed_over_by_user_id_users_id_fk" FOREIGN KEY ("handed_over_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_returns" ADD CONSTRAINT "store_receipt_returns_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_returns" ADD CONSTRAINT "store_receipt_returns_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipt_returns" ADD CONSTRAINT "store_receipt_returns_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_shortage_entitlements_adjustment_line_uidx" ON "receipt_shortage_entitlements" USING btree ("adjustment_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_shortage_entitlements_receipt_bag_uidx" ON "receipt_shortage_entitlements" USING btree ("store_receipt_bag_id");--> statement-breakpoint
CREATE INDEX "receipt_shortage_entitlements_wait_idx" ON "receipt_shortage_entitlements" USING btree ("wait_ticket_id");--> statement-breakpoint
CREATE INDEX "receipt_shortage_entitlements_store_idx" ON "receipt_shortage_entitlements" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "store_receipt_adjustment_lines_adjustment_bag_uidx" ON "store_receipt_adjustment_lines" USING btree ("adjustment_id","store_receipt_bag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_receipt_adjustment_lines_one_hold_uidx" ON "store_receipt_adjustment_lines" USING btree ("store_inventory_bag_id") WHERE "store_receipt_adjustment_lines"."hold_state" IN ('held', 'returning');--> statement-breakpoint
CREATE INDEX "store_receipt_adjustment_lines_receipt_bag_idx" ON "store_receipt_adjustment_lines" USING btree ("store_receipt_bag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_receipt_adjustments_code_uidx" ON "store_receipt_adjustments" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "store_receipt_adjustments_receipt_sequence_uidx" ON "store_receipt_adjustments" USING btree ("store_receipt_id","applied_sequence") WHERE "store_receipt_adjustments"."applied_sequence" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "store_receipt_adjustments_receipt_idx" ON "store_receipt_adjustments" USING btree ("store_receipt_id","created_at");--> statement-breakpoint
CREATE INDEX "store_receipt_adjustments_store_status_idx" ON "store_receipt_adjustments" USING btree ("store_id","status","created_at");--> statement-breakpoint
CREATE INDEX "store_receipt_adjustments_status_created_idx" ON "store_receipt_adjustments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "store_receipt_adjustments_applied_idx" ON "store_receipt_adjustments" USING btree ("applied_at") WHERE "store_receipt_adjustments"."status" = 'applied';--> statement-breakpoint
CREATE UNIQUE INDEX "store_receipt_returns_code_uidx" ON "store_receipt_returns" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "store_receipt_returns_one_open_per_line_uidx" ON "store_receipt_returns" USING btree ("adjustment_line_id") WHERE "store_receipt_returns"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "store_receipt_returns_store_status_idx" ON "store_receipt_returns" USING btree ("store_id","status","created_at");--> statement-breakpoint
CREATE INDEX "store_receipt_returns_status_idx" ON "store_receipt_returns" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "store_receipt_returns_handed_over_idx" ON "store_receipt_returns" USING btree ("handed_over_at");--> statement-breakpoint
ALTER TABLE "warehouse_shortage_checks" ADD CONSTRAINT "warehouse_shortage_checks_store_receipt_adjustment_line_id_store_receipt_adjustment_lines_id_fk" FOREIGN KEY ("store_receipt_adjustment_line_id") REFERENCES "public"."store_receipt_adjustment_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_shortage_checks_adjustment_line_uidx" ON "warehouse_shortage_checks" USING btree ("store_receipt_adjustment_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_shortage_checks_receipt_line_uidx" ON "warehouse_shortage_checks" USING btree ("store_receipt_line_id") WHERE "warehouse_shortage_checks"."store_receipt_adjustment_line_id" IS NULL;--> statement-breakpoint
-- Adjustment and return documents take public codes from the shared counter (0015).
CREATE TRIGGER store_receipt_adjustments_sequential_code_insert BEFORE INSERT ON store_receipt_adjustments
FOR EACH ROW EXECUTE FUNCTION assign_document_code('code', 'PSL');--> statement-breakpoint
CREATE TRIGGER store_receipt_returns_sequential_code_insert BEFORE INSERT ON store_receipt_returns
FOR EACH ROW EXECUTE FUNCTION assign_document_code('code', 'PTH');
