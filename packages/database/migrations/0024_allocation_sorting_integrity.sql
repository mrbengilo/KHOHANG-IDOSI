CREATE TYPE "public"."warehouse_shortage_check_status" AS ENUM('pending', 'returned_to_stock', 'lost');--> statement-breakpoint
CREATE TABLE "idosi_product_links" (
	"idosi_product_id" text PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"first_seen_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idosi_product_links_id_not_blank" CHECK (length(btrim("idosi_product_links"."idosi_product_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "store_normal_sale_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"period" text NOT NULL,
	"baseline_grams" bigint DEFAULT 0 NOT NULL,
	"observed_grams" bigint DEFAULT 0 NOT NULL,
	"applied_grams" bigint DEFAULT 0 NOT NULL,
	"source_snapshot_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_normal_sale_progress_period" CHECK ("store_normal_sale_progress"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "store_normal_sale_progress_nonnegative" CHECK ("store_normal_sale_progress"."baseline_grams" >= 0 AND "store_normal_sale_progress"."observed_grams" >= 0 AND "store_normal_sale_progress"."applied_grams" >= 0)
);
--> statement-breakpoint
CREATE TABLE "warehouse_shortage_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_receipt_line_id" uuid NOT NULL,
	"store_receipt_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" "warehouse_shortage_check_status" DEFAULT 'pending' NOT NULL,
	"shortage_reason" text,
	"resolution_reason" text,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_shortage_checks_quantity_positive" CHECK ("warehouse_shortage_checks"."quantity" > 0),
	CONSTRAINT "warehouse_shortage_checks_version_nonnegative" CHECK ("warehouse_shortage_checks"."version" >= 0),
	CONSTRAINT "warehouse_shortage_checks_resolution" CHECK (("warehouse_shortage_checks"."status" = 'pending' AND "warehouse_shortage_checks"."resolved_at" IS NULL AND "warehouse_shortage_checks"."resolved_by_user_id" IS NULL) OR ("warehouse_shortage_checks"."status" <> 'pending' AND "warehouse_shortage_checks"."resolved_at" IS NOT NULL AND "warehouse_shortage_checks"."resolved_by_user_id" IS NOT NULL AND length(btrim(coalesce("warehouse_shortage_checks"."resolution_reason", ''))) >= 3))
);
--> statement-breakpoint
ALTER TABLE "sorted_sale_transfers" DROP CONSTRAINT "sorted_sale_transfers_status";--> statement-breakpoint
ALTER TABLE "store_receipt_lines" DROP CONSTRAINT "store_receipt_lines_approved_positive";--> statement-breakpoint
ALTER TABLE "store_sorting_events" DROP CONSTRAINT "store_sorting_events_action";--> statement-breakpoint
DROP INDEX "order_requests_session_store_slot_uidx";--> statement-breakpoint
ALTER TABLE "store_inventory_ledger_entries" ALTER COLUMN "actor_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "store_receipt_lines" ALTER COLUMN "outbound_request_line_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sorted_sale_transfers" ADD COLUMN "cancelled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "sorted_sale_transfers" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "sorted_sale_transfers" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_inventory_bags" ADD COLUMN "normal_sale_consumed_kg" numeric(14, 3) DEFAULT '0.000' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_receipt_lines" ADD COLUMN "excess_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "idosi_product_links" ADD CONSTRAINT "idosi_product_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_normal_sale_progress" ADD CONSTRAINT "store_normal_sale_progress_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_normal_sale_progress" ADD CONSTRAINT "store_normal_sale_progress_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_normal_sale_progress" ADD CONSTRAINT "store_normal_sale_progress_source_snapshot_id_idosi_statistics_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."idosi_statistics_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_shortage_checks" ADD CONSTRAINT "warehouse_shortage_checks_store_receipt_line_id_store_receipt_lines_id_fk" FOREIGN KEY ("store_receipt_line_id") REFERENCES "public"."store_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_shortage_checks" ADD CONSTRAINT "warehouse_shortage_checks_store_receipt_id_store_receipts_id_fk" FOREIGN KEY ("store_receipt_id") REFERENCES "public"."store_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_shortage_checks" ADD CONSTRAINT "warehouse_shortage_checks_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_shortage_checks" ADD CONSTRAINT "warehouse_shortage_checks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_shortage_checks" ADD CONSTRAINT "warehouse_shortage_checks_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idosi_product_links_product_idx" ON "idosi_product_links" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_normal_sale_progress_scope_uidx" ON "store_normal_sale_progress" USING btree ("store_id","product_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_shortage_checks_receipt_line_uidx" ON "warehouse_shortage_checks" USING btree ("store_receipt_line_id");--> statement-breakpoint
CREATE INDEX "warehouse_shortage_checks_status_created_idx" ON "warehouse_shortage_checks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "warehouse_shortage_checks_store_idx" ON "warehouse_shortage_checks" USING btree ("store_id");--> statement-breakpoint
ALTER TABLE "sorted_sale_transfers" ADD CONSTRAINT "sorted_sale_transfers_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_requests_session_store_slot_uidx" ON "order_requests" USING btree ("order_session_id","store_id","request_number") WHERE "order_requests"."status" <> 'cancelled';--> statement-breakpoint
ALTER TABLE "sorted_sale_transfers" ADD CONSTRAINT "sorted_sale_transfers_cancellation" CHECK ("sorted_sale_transfers"."status" <> 'cancelled' OR ("sorted_sale_transfers"."cancelled_by_user_id" IS NOT NULL AND "sorted_sale_transfers"."cancelled_at" IS NOT NULL AND length(btrim(coalesce("sorted_sale_transfers"."cancellation_reason", ''))) >= 3));--> statement-breakpoint
ALTER TABLE "sorted_sale_transfers" ADD CONSTRAINT "sorted_sale_transfers_status" CHECK ("sorted_sale_transfers"."status" IN ('in_transit', 'received', 'cancelled'));--> statement-breakpoint
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_normal_sale_consumed" CHECK ("store_inventory_bags"."normal_sale_consumed_kg" >= 0 AND "store_inventory_bags"."normal_sale_consumed_kg" <= "store_inventory_bags"."initial_weight_kg");--> statement-breakpoint
ALTER TABLE "store_inventory_ledger_entries" ADD CONSTRAINT "store_inventory_ledger_actor" CHECK ("store_inventory_ledger_entries"."actor_user_id" IS NOT NULL OR "store_inventory_ledger_entries"."source_type" IN ('idosi_normal_sale', 'idosi_normal_sale_correction'));--> statement-breakpoint
ALTER TABLE "store_receipt_lines" ADD CONSTRAINT "store_receipt_lines_source" CHECK (("store_receipt_lines"."outbound_request_line_id" IS NOT NULL AND "store_receipt_lines"."approved_quantity" > 0) OR ("store_receipt_lines"."outbound_request_line_id" IS NULL AND "store_receipt_lines"."approved_quantity" = 0 AND "store_receipt_lines"."received_quantity" = 0 AND "store_receipt_lines"."excess_quantity" > 0));--> statement-breakpoint
ALTER TABLE "store_receipt_lines" ADD CONSTRAINT "store_receipt_lines_excess_nonnegative" CHECK ("store_receipt_lines"."excess_quantity" >= 0);--> statement-breakpoint
ALTER TABLE "store_sorting_events" ADD CONSTRAINT "store_sorting_events_action" CHECK ("store_sorting_events"."action" IN ('sort_sale', 'sort_charity', 'sort_cancel', 'charity_to_sale', 'charity_export', 'idosi_sale_kg', 'idosi_sale_piece', 'idosi_sale_correction', 'sale_transfer_out', 'sale_transfer_in', 'sale_transfer_return'));