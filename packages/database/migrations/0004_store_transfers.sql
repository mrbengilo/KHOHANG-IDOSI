-- Store transfer schema follows the operational settings migration.
CREATE TYPE "public"."store_transfer_status" AS ENUM('draft', 'in_transit', 'received', 'cancelled');

ALTER TABLE "store_inventory_bags" ALTER COLUMN "source_store_receipt_bag_id" DROP NOT NULL;
ALTER TABLE "store_inventory_bags" ADD COLUMN "source_transfer_id" uuid;
ALTER TABLE "store_inventory_bags" ADD COLUMN "source_inventory_bag_id" uuid;
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_source_inventory_bag_id_store_inventory_bags_id_fk"
  FOREIGN KEY ("source_inventory_bag_id") REFERENCES "public"."store_inventory_bags"("id") ON DELETE restrict;
CREATE INDEX "store_inventory_bags_source_transfer_idx" ON "store_inventory_bags" USING btree ("source_transfer_id");
CREATE INDEX "store_inventory_bags_source_inventory_bag_idx" ON "store_inventory_bags" USING btree ("source_inventory_bag_id");
CREATE UNIQUE INDEX "store_inventory_bags_source_transfer_uidx" ON "store_inventory_bags" USING btree ("source_transfer_id");
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_exactly_one_provenance"
  CHECK ((("source_store_receipt_bag_id" IS NOT NULL)::integer + ("source_transfer_id" IS NOT NULL)::integer) = 1);
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_transfer_parent"
  CHECK ("source_transfer_id" IS NULL OR "source_inventory_bag_id" IS NOT NULL);

CREATE TABLE "store_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transfer_number" text NOT NULL,
  "source_store_id" uuid NOT NULL,
  "destination_store_id" uuid NOT NULL,
  "source_inventory_bag_id" uuid NOT NULL,
  "destination_inventory_bag_id" uuid,
  "product_id" uuid NOT NULL,
  "weight_kg" numeric(14, 3) NOT NULL,
  "cost_vnd" bigint,
  "status" "store_transfer_status" DEFAULT 'draft' NOT NULL,
  "note" text,
  "cancellation_reason" text,
  "version" integer DEFAULT 0 NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "dispatched_by_user_id" uuid,
  "received_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dispatched_at" timestamp with time zone,
  "received_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "store_transfers_transfer_number_unique" UNIQUE("transfer_number"),
  CONSTRAINT "store_transfers_number_not_blank" CHECK (length(btrim("transfer_number")) > 0),
  CONSTRAINT "store_transfers_distinct_stores" CHECK ("source_store_id" <> "destination_store_id"),
  CONSTRAINT "store_transfers_weight_positive" CHECK ("weight_kg" > 0),
  CONSTRAINT "store_transfers_cost_nonnegative" CHECK ("cost_vnd" IS NULL OR "cost_vnd" >= 0),
  CONSTRAINT "store_transfers_version_nonnegative" CHECK ("version" >= 0),
  CONSTRAINT "store_transfers_dispatch_state" CHECK ("status" = 'draft' OR "status" = 'cancelled' OR ("cost_vnd" IS NOT NULL AND "dispatched_by_user_id" IS NOT NULL AND "dispatched_at" IS NOT NULL)),
  CONSTRAINT "store_transfers_receive_state" CHECK ("status" <> 'received' OR ("destination_inventory_bag_id" IS NOT NULL AND "received_by_user_id" IS NOT NULL AND "received_at" IS NOT NULL)),
  CONSTRAINT "store_transfers_cancel_state" CHECK ("status" <> 'cancelled' OR ("cancelled_at" IS NOT NULL AND length(btrim("cancellation_reason")) >= 3))
);

ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_source_store_id_stores_id_fk" FOREIGN KEY ("source_store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_destination_store_id_stores_id_fk" FOREIGN KEY ("destination_store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_source_inventory_bag_id_store_inventory_bags_id_fk" FOREIGN KEY ("source_inventory_bag_id") REFERENCES "public"."store_inventory_bags"("id") ON DELETE restrict;
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_destination_inventory_bag_id_store_inventory_bags_id_fk" FOREIGN KEY ("destination_inventory_bag_id") REFERENCES "public"."store_inventory_bags"("id") ON DELETE restrict;
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict;
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict;
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_dispatched_by_user_id_users_id_fk" FOREIGN KEY ("dispatched_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict;
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict;
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_source_transfer_id_store_transfers_id_fk" FOREIGN KEY ("source_transfer_id") REFERENCES "public"."store_transfers"("id") ON DELETE restrict;
CREATE INDEX "store_transfers_source_status_created_idx" ON "store_transfers" USING btree ("source_store_id", "status", "created_at");
CREATE INDEX "store_transfers_destination_status_created_idx" ON "store_transfers" USING btree ("destination_store_id", "status", "created_at");
CREATE INDEX "store_transfers_product_created_idx" ON "store_transfers" USING btree ("product_id", "created_at");
