-- Expand-only release: several independent allocation sessions per business date, priority
-- offers owned by the session that created them, an order-history read index, and audited
-- central-warehouse stock adjustments. Nothing is dropped from a table and no column becomes
-- required without a default, so the previous API/worker keep working while this runs.
--
-- 1. Session kind. DEFAULT is the system-owned session of a business date; MANUAL is an extra
--    session an Admin schedules. The kind is taken from immutable evidence: createOrderSession
--    always wrote ORDER_SESSION_CREATED in the same transaction, the automatic paths never did.
CREATE TYPE "public"."order_session_kind" AS ENUM('default', 'manual');--> statement-breakpoint
ALTER TABLE "order_sessions" ADD COLUMN "kind" "order_session_kind" DEFAULT 'default' NOT NULL;--> statement-breakpoint
-- Classification is not a business change of the session: keep its version and updated_at.
ALTER TABLE "order_sessions" DISABLE TRIGGER "order_sessions_set_updated_at_and_bump_version";--> statement-breakpoint
UPDATE "order_sessions" AS s
SET "kind" = 'manual'
WHERE EXISTS (
  SELECT 1 FROM "audit_logs" a
  WHERE a."entity_type" = 'order_session'
    AND a."entity_id" = s."id"
    AND a."action" = 'ORDER_SESSION_CREATED'
);--> statement-breakpoint
-- The automatic paths only ever created a session for a date that had none, so a second DEFAULT
-- on one date cannot come from them. Should one exist anyway, the earliest stays DEFAULT and the
-- others become MANUAL, each with an audit row naming the evidence, instead of failing deploy.
WITH ranked AS (
  SELECT "id", "business_date",
    row_number() OVER (PARTITION BY "business_date" ORDER BY "created_at", "id") AS position
  FROM "order_sessions"
  WHERE "kind" = 'default' AND "deleted_at" IS NULL
), reclassified AS (
  UPDATE "order_sessions" AS s SET "kind" = 'manual'
  FROM ranked
  WHERE ranked."id" = s."id" AND ranked.position > 1
  RETURNING s."id", s."business_date"
)
INSERT INTO "audit_logs" ("action", "entity_type", "entity_id", "metadata")
SELECT 'ORDER_SESSION_KIND_BACKFILLED', 'order_session', "id",
  jsonb_build_object(
    'kind', 'manual',
    'businessDate', "business_date",
    'reason', 'Second automatic session on one business date; the earliest stays the default.'
  )
FROM reclassified;--> statement-breakpoint
ALTER TABLE "order_sessions" ENABLE TRIGGER "order_sessions_set_updated_at_and_bump_version";--> statement-breakpoint
CREATE UNIQUE INDEX "order_sessions_one_default_per_day_uidx" ON "order_sessions" USING btree ("business_date") WHERE "order_sessions"."kind" = 'default' AND "order_sessions"."deleted_at" IS NULL;--> statement-breakpoint

-- 2. Priority offer ownership. Backfilled only from proof, strongest first; an offer whose owner
--    stays ambiguous keeps NULL and the historical one-session-per-date scope.
ALTER TABLE "daily_priority_offers" ADD COLUMN "order_session_id" uuid;--> statement-breakpoint
ALTER TABLE "daily_priority_offers" ADD CONSTRAINT "daily_priority_offers_order_session_id_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."order_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_priority_offers" DISABLE TRIGGER "daily_priority_offers_set_updated_at";--> statement-breakpoint
-- a) The run that allocated an accepted offer.
UPDATE "daily_priority_offers" AS o
SET "order_session_id" = proof.session_id
FROM (
  SELECT l."priority_offer_id" AS offer_id, min(r."order_session_id"::text)::uuid AS session_id
  FROM "allocation_lines" l
  JOIN "allocation_runs" r ON r."id" = l."allocation_run_id"
  WHERE l."priority_offer_id" IS NOT NULL
  GROUP BY l."priority_offer_id"
  HAVING count(DISTINCT r."order_session_id") = 1
) AS proof
WHERE proof.offer_id = o."id" AND o."order_session_id" IS NULL;--> statement-breakpoint
-- b) The snapshot job stamps an offer with its session's snapshot instant and allocation time.
UPDATE "daily_priority_offers" AS o
SET "order_session_id" = proof.session_id
FROM (
  SELECT candidate."id" AS offer_id, min(s."id"::text)::uuid AS session_id
  FROM "daily_priority_offers" candidate
  JOIN "order_sessions" s
    ON s."business_date" = candidate."business_date"
   AND s."inventory_snapshot_due_at" = candidate."created_at"
   AND s."request_deadline_at" = candidate."response_deadline_at"
  JOIN "inventory_snapshots" i
    ON i."order_session_id" = s."id"
   AND i."business_date" = candidate."business_date"
   AND i."snapshot_type" = 'opening_0800'
   AND i."status" = 'completed'
   AND i."deleted_at" IS NULL
  WHERE candidate."order_session_id" IS NULL
  GROUP BY candidate."id"
  HAVING count(DISTINCT s."id") = 1
) AS proof
WHERE proof.offer_id = o."id" AND o."order_session_id" IS NULL;--> statement-breakpoint
-- c) Before this release a business date had exactly one session with an opening snapshot.
UPDATE "daily_priority_offers" AS o
SET "order_session_id" = proof.session_id
FROM (
  SELECT candidate."id" AS offer_id, min(i."order_session_id"::text)::uuid AS session_id
  FROM "daily_priority_offers" candidate
  JOIN "inventory_snapshots" i
    ON i."business_date" = candidate."business_date"
   AND i."snapshot_type" = 'opening_0800'
   AND i."status" = 'completed'
   AND i."deleted_at" IS NULL
   AND i."order_session_id" IS NOT NULL
  WHERE candidate."order_session_id" IS NULL
  GROUP BY candidate."id"
  HAVING count(DISTINCT i."order_session_id") = 1
) AS proof
WHERE proof.offer_id = o."id" AND o."order_session_id" IS NULL;--> statement-breakpoint
ALTER TABLE "daily_priority_offers" ENABLE TRIGGER "daily_priority_offers_set_updated_at";--> statement-breakpoint
-- Uniqueness moves from the date to the owning session. Rows without an owner (legacy, or written
-- by the previous worker during deploy) keep exactly the old date-scoped guarantees.
DROP INDEX "daily_priority_offers_day_store_product_round_uidx";--> statement-breakpoint
DROP INDEX "daily_priority_offers_one_open_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "daily_priority_offers_day_store_product_round_uidx" ON "daily_priority_offers" USING btree ("business_date","store_id","product_id","round_number") WHERE "daily_priority_offers"."order_session_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_priority_offers_one_open_uidx" ON "daily_priority_offers" USING btree ("business_date","store_id","product_id") WHERE "daily_priority_offers"."order_session_id" IS NULL AND "daily_priority_offers"."status" = 'offered' AND "daily_priority_offers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_priority_offers_session_store_product_round_uidx" ON "daily_priority_offers" USING btree ("order_session_id","store_id","product_id","round_number") WHERE "daily_priority_offers"."order_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_priority_offers_session_one_open_uidx" ON "daily_priority_offers" USING btree ("order_session_id","store_id","product_id") WHERE "daily_priority_offers"."order_session_id" IS NOT NULL AND "daily_priority_offers"."status" = 'offered' AND "daily_priority_offers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "daily_priority_offers_session_status_idx" ON "daily_priority_offers" USING btree ("order_session_id","status");--> statement-breakpoint

-- 3. Order history pages newest first, for one store or across all stores.
CREATE INDEX "order_requests_store_submitted_idx" ON "order_requests" USING btree ("store_id","submitted_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "order_requests_submitted_idx" ON "order_requests" USING btree ("submitted_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint

-- 4. Audited, immutable central-warehouse stock adjustments. The balance itself still changes only
--    through warehouse_ledger_entries; this table is the document each ledger entry points back to.
CREATE TYPE "public"."warehouse_adjustment_direction" AS ENUM('increase', 'decrease');--> statement-breakpoint
CREATE TYPE "public"."warehouse_adjustment_reason" AS ENUM('count_correction', 'damage', 'return', 'receipt_correction', 'outbound_correction', 'other');--> statement-breakpoint
CREATE TABLE "warehouse_stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"product_id" uuid NOT NULL,
	"direction" "warehouse_adjustment_direction" NOT NULL,
	"quantity" integer NOT NULL,
	"reason_code" "warehouse_adjustment_reason" NOT NULL,
	"reason" text NOT NULL,
	"on_hand_before" integer NOT NULL,
	"reserved_before" integer NOT NULL,
	"on_hand_after" integer NOT NULL,
	"reserved_after" integer NOT NULL,
	"balance_version_before" integer NOT NULL,
	"balance_version_after" integer NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"compensates_adjustment_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_id" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_stock_adjustments_quantity_positive" CHECK ("warehouse_stock_adjustments"."quantity" > 0),
	CONSTRAINT "warehouse_stock_adjustments_reason_length" CHECK (length(btrim("warehouse_stock_adjustments"."reason")) BETWEEN 3 AND 500),
	CONSTRAINT "warehouse_stock_adjustments_delta_consistent" CHECK ("warehouse_stock_adjustments"."on_hand_after" - "warehouse_stock_adjustments"."on_hand_before" = CASE "warehouse_stock_adjustments"."direction" WHEN 'increase' THEN "warehouse_stock_adjustments"."quantity" ELSE -"warehouse_stock_adjustments"."quantity" END),
	CONSTRAINT "warehouse_stock_adjustments_reserved_untouched" CHECK ("warehouse_stock_adjustments"."reserved_after" = "warehouse_stock_adjustments"."reserved_before"),
	CONSTRAINT "warehouse_stock_adjustments_balance_valid" CHECK ("warehouse_stock_adjustments"."on_hand_before" >= 0 AND "warehouse_stock_adjustments"."reserved_before" >= 0 AND "warehouse_stock_adjustments"."reserved_before" <= "warehouse_stock_adjustments"."on_hand_before" AND "warehouse_stock_adjustments"."reserved_after" <= "warehouse_stock_adjustments"."on_hand_after"),
	CONSTRAINT "warehouse_stock_adjustments_version_advances" CHECK ("warehouse_stock_adjustments"."balance_version_after" > "warehouse_stock_adjustments"."balance_version_before" AND "warehouse_stock_adjustments"."balance_version_before" >= 0),
	CONSTRAINT "warehouse_stock_adjustments_not_self_compensating" CHECK ("warehouse_stock_adjustments"."compensates_adjustment_id" IS NULL OR "warehouse_stock_adjustments"."compensates_adjustment_id" <> "warehouse_stock_adjustments"."id")
);
--> statement-breakpoint
ALTER TABLE "warehouse_stock_adjustments" ADD CONSTRAINT "warehouse_stock_adjustments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_stock_adjustments" ADD CONSTRAINT "warehouse_stock_adjustments_ledger_entry_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."warehouse_ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_stock_adjustments" ADD CONSTRAINT "warehouse_stock_adjustments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_stock_adjustments" ADD CONSTRAINT "warehouse_stock_adjustments_compensates_fk" FOREIGN KEY ("compensates_adjustment_id") REFERENCES "public"."warehouse_stock_adjustments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_stock_adjustments_code_uidx" ON "warehouse_stock_adjustments" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_stock_adjustments_ledger_uidx" ON "warehouse_stock_adjustments" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_stock_adjustments_actor_key_uidx" ON "warehouse_stock_adjustments" USING btree ("created_by_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "warehouse_stock_adjustments_created_idx" ON "warehouse_stock_adjustments" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "warehouse_stock_adjustments_product_created_idx" ON "warehouse_stock_adjustments" USING btree ("product_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE TRIGGER warehouse_stock_adjustments_sequential_code_insert BEFORE INSERT ON warehouse_stock_adjustments
FOR EACH ROW EXECUTE FUNCTION assign_document_code('code', 'DCK');--> statement-breakpoint
ALTER TABLE "warehouse_stock_adjustments" ADD CONSTRAINT "warehouse_stock_adjustments_short_code" CHECK ("code" ~ '^DCK-[0-9]{6}$');--> statement-breakpoint
CREATE TRIGGER warehouse_stock_adjustments_immutable BEFORE UPDATE OR DELETE ON warehouse_stock_adjustments
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();
