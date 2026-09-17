CREATE TYPE "public"."store_kind" AS ENUM('retail', 'wholesale');--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "kind" "store_kind" DEFAULT 'retail' NOT NULL;--> statement-breakpoint
UPDATE "stores"
SET "kind" = 'wholesale'::"store_kind"
FROM "store_groups"
WHERE "stores"."group_id" = "store_groups"."id"
  AND "store_groups"."code" = 'SI_TINH';--> statement-breakpoint
CREATE INDEX "stores_kind_active_idx" ON "stores" USING btree ("kind", "is_active", "display_order");--> statement-breakpoint

-- Reconcile the legacy reference catalog before attaching conversion history.
-- The SKU rename deliberately preserves the existing product UUID and every FK that points to it.
UPDATE "store_groups"
SET "name" = 'KHÁCH SỈ', "updated_at" = now()
WHERE "code" = 'SI_TINH';--> statement-breakpoint
UPDATE "products"
SET "sku" = 'DO_NAM',
    "slug" = 'do-nam',
    "name" = 'Đồ nam',
    "display_order" = 12,
    "version" = "version" + 1,
    "updated_at" = now()
WHERE "sku" = 'DO_NAM_CUA_HANG';--> statement-breakpoint
UPDATE "products"
SET "name" = 'Quần Jeans', "display_order" = 2, "version" = "version" + 1, "updated_at" = now()
WHERE "sku" = 'QUAN_JEANS';--> statement-breakpoint
UPDATE "products"
SET "name" = 'Sản phẩm tiện ích', "display_order" = 17, "version" = "version" + 1, "updated_at" = now()
WHERE "sku" = 'SAN_PHAM_TIEN_ICH';--> statement-breakpoint
UPDATE "products"
SET "name" = 'Giày dép túi xách', "display_order" = 18, "version" = "version" + 1, "updated_at" = now()
WHERE "sku" = 'GIAY_DEP_TUI_XACH';--> statement-breakpoint
UPDATE "products"
SET "name" = 'Chăn, ga, bao gối, nệm gòn', "display_order" = 23, "version" = "version" + 1, "updated_at" = now()
WHERE "sku" = 'CHAN_GA_BAO_GOI_NEM_GON';--> statement-breakpoint
UPDATE "products"
SET "is_active" = false,
    "deleted_at" = COALESCE("deleted_at", now()),
    "version" = "version" + 1,
    "updated_at" = now()
WHERE "sku" IN ('THAP_CAM_TON', 'HANG_JEANS_TAI_CHE', 'HANG_THUN_TAI_CHE')
  AND ("is_active" OR "deleted_at" IS NULL);--> statement-breakpoint

CREATE TABLE "product_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"item_quantity" integer NOT NULL,
	"weight_kilograms" numeric(14, 3) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"reason" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by_user_id" uuid,
	"retirement_reason" text,
	CONSTRAINT "product_conversions_version_positive" CHECK ("product_conversions"."version" > 0),
	CONSTRAINT "product_conversions_item_quantity_positive" CHECK ("product_conversions"."item_quantity" > 0),
	CONSTRAINT "product_conversions_weight_positive" CHECK ("product_conversions"."weight_kilograms" > 0),
	CONSTRAINT "product_conversions_effective_period_valid" CHECK ("product_conversions"."effective_to" IS NULL OR "product_conversions"."effective_to" > "product_conversions"."effective_from" OR ("product_conversions"."effective_to" = "product_conversions"."effective_from" AND "product_conversions"."retired_at" IS NOT NULL)),
	CONSTRAINT "product_conversions_reason_not_blank" CHECK (length(btrim("product_conversions"."reason")) >= 3),
	CONSTRAINT "product_conversions_retirement_consistent" CHECK (
		("product_conversions"."retired_at" IS NULL AND "product_conversions"."retired_by_user_id" IS NULL AND "product_conversions"."retirement_reason" IS NULL)
		OR
		("product_conversions"."retired_at" IS NOT NULL AND "product_conversions"."retired_by_user_id" IS NOT NULL AND "product_conversions"."retirement_reason" IS NOT NULL AND length(btrim("product_conversions"."retirement_reason")) >= 3 AND "product_conversions"."effective_to" IS NOT NULL)
	)
);--> statement-breakpoint
ALTER TABLE "product_conversions" ADD CONSTRAINT "product_conversions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_conversions" ADD CONSTRAINT "product_conversions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_conversions" ADD CONSTRAINT "product_conversions_retired_by_user_id_users_id_fk" FOREIGN KEY ("retired_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_conversions_product_version_uidx" ON "product_conversions" USING btree ("product_id", "version");--> statement-breakpoint
CREATE UNIQUE INDEX "product_conversions_product_effective_from_uidx" ON "product_conversions" USING btree ("product_id", "effective_from");--> statement-breakpoint
CREATE INDEX "product_conversions_product_period_idx" ON "product_conversions" USING btree ("product_id", "effective_from", "effective_to");--> statement-breakpoint
CREATE INDEX "product_conversions_active_idx" ON "product_conversions" USING btree ("product_id", "effective_from") WHERE "product_conversions"."retired_at" IS NULL;--> statement-breakpoint

-- Serialize changes per product and reject overlapping half-open effective periods.
CREATE FUNCTION product_conversions_validate_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM products WHERE id = NEW.product_id FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM product_conversions existing
    WHERE existing.product_id = NEW.product_id
      AND existing.id <> NEW.id
      AND existing.version <> NEW.version
      AND daterange(existing.effective_from, existing.effective_to, '[)')
          && daterange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'product conversion periods may not overlap for product %', NEW.product_id
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Ratio versions are immutable. The only permitted mutation closes and retires one version.
CREATE FUNCTION product_conversions_protect_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hard delete is disabled for table %', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;

  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'retired product conversion versions are immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.item_quantity IS DISTINCT FROM OLD.item_quantity
    OR NEW.weight_kilograms IS DISTINCT FROM OLD.weight_kilograms
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'product conversion ratio versions are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'a closed product conversion period cannot be changed' USING ERRCODE = '55000';
  END IF;

  IF NEW.effective_to IS DISTINCT FROM OLD.effective_to AND NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'closing a conversion requires retirement audit data' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER product_conversions_protect_history BEFORE UPDATE OR DELETE ON product_conversions FOR EACH ROW EXECUTE FUNCTION product_conversions_protect_history();--> statement-breakpoint
CREATE TRIGGER product_conversions_validate_period BEFORE INSERT OR UPDATE OF effective_from, effective_to, product_id ON product_conversions FOR EACH ROW EXECUTE FUNCTION product_conversions_validate_period();--> statement-breakpoint

-- Baseline catalog from the approved Figma specification. Text casts preserve exact decimals.
INSERT INTO "product_conversions" (
  "product_id",
  "version",
  "item_quantity",
  "weight_kilograms",
  "effective_from",
  "effective_to",
  "reason"
)
SELECT
  "products"."id",
  1,
  seed."item_quantity",
  seed."weight_kilograms"::numeric(14, 3),
  DATE '2026-09-12',
  NULL,
  'Initial Figma catalog conversion effective 2026-09-12'
FROM (
  VALUES
    ('DAM', 3, '1.000'),
    ('QUAN_JEANS', 2, '1.000'),
    ('QUAN_DAI_NU', 3, '1.000'),
    ('CHAN_VAY', 3, '1.000'),
    ('QUAN_SHORT', 4, '1.000'),
    ('TRE_EM', 6, '1.000'),
    ('DO_DONG', 1, '1.000'),
    ('DO_BO', 3, '1.000'),
    ('DO_THE_THAO', 4, '1.000'),
    ('AO_KHOAC', 2, '1.000'),
    ('AO_NU', 5, '1.000'),
    ('DO_NAM', 3, '1.000'),
    ('NAM_SM', 3, '1.000'),
    ('NU_SM', 5, '1.000'),
    ('AO_VEST', 1, '1.000'),
    ('AO_DAI', 2, '1.000'),
    ('SAN_PHAM_TIEN_ICH', 1, '1.000'),
    ('GIAY_DEP_TUI_XACH', 1, '1.000'),
    ('BIG_SIZE', 3, '1.000'),
    ('HANG_THUONG_HIEU', 3, '1.000'),
    ('TRE_EM_SM', 6, '1.000'),
    ('KHAN_LONG', 2, '1.000'),
    ('CHAN_GA_BAO_GOI_NEM_GON', 1, '3.000'),
    ('DO_NOI_Y_MOI', 4, '1.000'),
    ('GAU_BONG', 2, '1.000')
) AS seed("sku", "item_quantity", "weight_kilograms")
JOIN "products" ON "products"."sku" = seed."sku"
ON CONFLICT ("product_id", "version") DO NOTHING;
