CREATE TABLE "test_data_reset_baselines" (
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"period" text NOT NULL,
	"revenue_type" text NOT NULL,
	"link_signature" text NOT NULL,
	"status" text NOT NULL,
	"baseline_grams" bigint NOT NULL,
	"established_at" timestamp with time zone,
	CONSTRAINT "test_data_reset_baselines_store_id_product_id_period_revenue_type_pk" PRIMARY KEY("store_id","product_id","period","revenue_type"),
	CONSTRAINT "test_data_reset_baselines_revenue_type_check" CHECK ("test_data_reset_baselines"."revenue_type" IN ('normal','sale_kg','sale_piece')),
	CONSTRAINT "test_data_reset_baselines_status_check" CHECK ("test_data_reset_baselines"."status" IN ('pending','ready','mapping_review')),
	CONSTRAINT "test_data_reset_baselines_baseline_grams_check" CHECK ("test_data_reset_baselines"."baseline_grams" >= 0)
);
--> statement-breakpoint
CREATE TABLE "test_data_reset_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"manifest_hash" text NOT NULL,
	"cutoff" timestamp with time zone NOT NULL,
	"phase" text NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_data_reset_operations_phase_check" CHECK ("test_data_reset_operations"."phase" IN ('DATABASE_COMMITTED','VERIFIED','BACKUPS_PURGED','COMPLETE'))
);
--> statement-breakpoint
ALTER TABLE "test_data_reset_baselines" ADD CONSTRAINT "test_data_reset_baselines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_data_reset_baselines" ADD CONSTRAINT "test_data_reset_baselines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "test_data_reset_replay_keys" (
  "key_hash" text PRIMARY KEY NOT NULL
);
-- Additive structures only. The one-shot purge is never invoked by a migration.
