-- Goods a store receives straight from a partner, outside warehouse allocation.
-- The slip is final on save: nothing was dispatched by the warehouse, so there is no
-- review step and no dispatched quantity to reconcile against. Each received unit is a
-- real bag with its own weight, so partner stock joins the same store inventory as
-- warehouse stock and can be opened, sold and transferred without a second stock model.
CREATE SEQUENCE IF NOT EXISTS "store_partner_inbound_number_seq";

CREATE TABLE "store_partner_inbounds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reference_code" text NOT NULL,
  "store_id" uuid NOT NULL,
  "partner_name" text NOT NULL,
  "note" text,
  "total_quantity" integer NOT NULL,
  "total_weight_kg" numeric(14, 3) NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "store_partner_inbounds_reference_code_unique" UNIQUE("reference_code"),
  CONSTRAINT "store_partner_inbounds_reference_not_blank" CHECK (length(btrim("reference_code")) > 0),
  CONSTRAINT "store_partner_inbounds_partner_not_blank" CHECK (length(btrim("partner_name")) > 0),
  CONSTRAINT "store_partner_inbounds_quantity_positive" CHECK ("total_quantity" > 0),
  CONSTRAINT "store_partner_inbounds_weight_positive" CHECK ("total_weight_kg" > 0)
);
ALTER TABLE "store_partner_inbounds" ADD CONSTRAINT "store_partner_inbounds_store_id_stores_id_fk"
  FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;
ALTER TABLE "store_partner_inbounds" ADD CONSTRAINT "store_partner_inbounds_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict;
CREATE INDEX "store_partner_inbounds_store_received_idx" ON "store_partner_inbounds" USING btree ("store_id", "received_at");

CREATE TABLE "store_partner_inbound_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_partner_inbound_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "quantity" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "store_partner_inbound_lines_quantity_positive" CHECK ("quantity" > 0)
);
ALTER TABLE "store_partner_inbound_lines" ADD CONSTRAINT "store_partner_inbound_lines_slip_fk"
  FOREIGN KEY ("store_partner_inbound_id") REFERENCES "public"."store_partner_inbounds"("id") ON DELETE cascade;
ALTER TABLE "store_partner_inbound_lines" ADD CONSTRAINT "store_partner_inbound_lines_product_id_products_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict;
CREATE UNIQUE INDEX "store_partner_inbound_lines_slip_product_uidx" ON "store_partner_inbound_lines" USING btree ("store_partner_inbound_id", "product_id");

CREATE TABLE "store_partner_inbound_bags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_partner_inbound_line_id" uuid NOT NULL,
  "bag_number" integer NOT NULL,
  "bag_code" text NOT NULL,
  "weight_kg" numeric(14, 3) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "store_partner_inbound_bags_bag_code_unique" UNIQUE("bag_code"),
  CONSTRAINT "store_partner_inbound_bags_number_positive" CHECK ("bag_number" > 0),
  CONSTRAINT "store_partner_inbound_bags_code_not_blank" CHECK (length(btrim("bag_code")) > 0),
  CONSTRAINT "store_partner_inbound_bags_weight_positive" CHECK ("weight_kg" > 0)
);
ALTER TABLE "store_partner_inbound_bags" ADD CONSTRAINT "store_partner_inbound_bags_line_fk"
  FOREIGN KEY ("store_partner_inbound_line_id") REFERENCES "public"."store_partner_inbound_lines"("id") ON DELETE cascade;
CREATE UNIQUE INDEX "store_partner_inbound_bags_line_number_uidx" ON "store_partner_inbound_bags" USING btree ("store_partner_inbound_line_id", "bag_number");

-- Partner goods become ordinary store stock, so the provenance check grows a third source
-- instead of partner bags living outside the inventory the store already works with.
ALTER TABLE "store_inventory_bags" ADD COLUMN "source_partner_inbound_bag_id" uuid;
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_partner_inbound_bag_fk"
  FOREIGN KEY ("source_partner_inbound_bag_id") REFERENCES "public"."store_partner_inbound_bags"("id") ON DELETE restrict;
CREATE UNIQUE INDEX "store_inventory_bags_partner_inbound_bag_uidx" ON "store_inventory_bags" USING btree ("source_partner_inbound_bag_id");
ALTER TABLE "store_inventory_bags" DROP CONSTRAINT "store_inventory_bags_exactly_one_provenance";
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_exactly_one_provenance"
  CHECK ((("source_store_receipt_bag_id" IS NOT NULL)::integer + ("source_transfer_id" IS NOT NULL)::integer + ("source_partner_inbound_bag_id" IS NOT NULL)::integer) = 1);
