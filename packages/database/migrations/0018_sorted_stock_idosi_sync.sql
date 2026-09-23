CREATE TABLE "store_sale_sync_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"period" text NOT NULL,
	"sale_type" text NOT NULL,
	"baseline_grams" bigint DEFAULT 0 NOT NULL,
	"observed_grams" bigint DEFAULT 0 NOT NULL,
	"applied_grams" bigint DEFAULT 0 NOT NULL,
	"source_snapshot_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_sale_sync_progress_period" CHECK ("store_sale_sync_progress"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "store_sale_sync_progress_type" CHECK ("store_sale_sync_progress"."sale_type" IN ('sale_kg', 'sale_piece')),
	CONSTRAINT "store_sale_sync_progress_nonnegative" CHECK ("store_sale_sync_progress"."baseline_grams" >= 0 AND "store_sale_sync_progress"."observed_grams" >= 0 AND "store_sale_sync_progress"."applied_grams" >= 0)
);
--> statement-breakpoint
CREATE TABLE "store_sorted_stocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"store_inventory_bag_id" uuid NOT NULL,
	"sale_credited_weight_kg" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"sale_weight_kg" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"charity_weight_kg" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_sorted_stocks_sale_nonnegative" CHECK ("store_sorted_stocks"."sale_weight_kg" >= 0),
	CONSTRAINT "store_sorted_stocks_sale_within_credited" CHECK ("store_sorted_stocks"."sale_weight_kg" <= "store_sorted_stocks"."sale_credited_weight_kg"),
	CONSTRAINT "store_sorted_stocks_charity_nonnegative" CHECK ("store_sorted_stocks"."charity_weight_kg" >= 0),
	CONSTRAINT "store_sorted_stocks_version_nonnegative" CHECK ("store_sorted_stocks"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "store_sorting_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_sorted_stock_id" uuid,
	"store_inventory_bag_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"action" text NOT NULL,
	"weight_kg" numeric(14, 3) NOT NULL,
	"piece_count" integer,
	"source_snapshot_id" uuid,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_sorting_events_weight_positive" CHECK ("store_sorting_events"."weight_kg" > 0),
	CONSTRAINT "store_sorting_events_action" CHECK ("store_sorting_events"."action" IN ('sort_sale', 'sort_charity', 'sort_cancel', 'charity_to_sale', 'charity_export', 'idosi_sale_kg', 'idosi_sale_piece', 'idosi_sale_correction')),
	CONSTRAINT "store_sorting_events_piece_positive" CHECK ("store_sorting_events"."piece_count" IS NULL OR "store_sorting_events"."piece_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "store_sale_sync_progress" ADD CONSTRAINT "store_sale_sync_progress_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sale_sync_progress" ADD CONSTRAINT "store_sale_sync_progress_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sale_sync_progress" ADD CONSTRAINT "store_sale_sync_progress_source_snapshot_id_idosi_statistics_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."idosi_statistics_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sorted_stocks" ADD CONSTRAINT "store_sorted_stocks_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sorted_stocks" ADD CONSTRAINT "store_sorted_stocks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sorted_stocks" ADD CONSTRAINT "store_sorted_stocks_store_inventory_bag_id_store_inventory_bags_id_fk" FOREIGN KEY ("store_inventory_bag_id") REFERENCES "public"."store_inventory_bags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sorting_events" ADD CONSTRAINT "store_sorting_events_store_sorted_stock_id_store_sorted_stocks_id_fk" FOREIGN KEY ("store_sorted_stock_id") REFERENCES "public"."store_sorted_stocks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sorting_events" ADD CONSTRAINT "store_sorting_events_store_inventory_bag_id_store_inventory_bags_id_fk" FOREIGN KEY ("store_inventory_bag_id") REFERENCES "public"."store_inventory_bags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sorting_events" ADD CONSTRAINT "store_sorting_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sorting_events" ADD CONSTRAINT "store_sorting_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sorting_events" ADD CONSTRAINT "store_sorting_events_source_snapshot_id_idosi_statistics_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."idosi_statistics_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sorting_events" ADD CONSTRAINT "store_sorting_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_sale_sync_progress_scope_uidx" ON "store_sale_sync_progress" USING btree ("store_id","product_id","period","sale_type");--> statement-breakpoint
CREATE UNIQUE INDEX "store_sorted_stocks_bag_uidx" ON "store_sorted_stocks" USING btree ("store_inventory_bag_id");--> statement-breakpoint
CREATE INDEX "store_sorted_stocks_store_product_idx" ON "store_sorted_stocks" USING btree ("store_id","product_id");--> statement-breakpoint
CREATE INDEX "store_sorting_events_store_occurred_idx" ON "store_sorting_events" USING btree ("store_id","occurred_at");