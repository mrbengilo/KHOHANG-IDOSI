-- Expand-only release (docs/reshare-auto-orders.md). Accepting an allocation result with new
-- goods now creates an internal Reshare order (RE-000001...) and issues those goods out of the
-- central warehouse in the same transaction. No existing stock, reservation, shipment or receipt
-- is rewritten here; legacy holds keep the receipt-time deduction until a reviewed cutover.
-- The new 'issued' reservation status is only referenced inside trigger bodies (evaluated at
-- run time, after this migration commits), never by DDL evaluated in this transaction.
CREATE TYPE "public"."reshare_order_status" AS ENUM('ordered', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."reservation_status" ADD VALUE 'issued';--> statement-breakpoint
CREATE TABLE "reshare_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reshare_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name_snapshot" text NOT NULL,
	"product_sku_snapshot" text NOT NULL,
	"quantity" integer NOT NULL,
	"issue_ledger_entry_id" uuid NOT NULL,
	"supplier_reflected_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reshare_order_lines_quantity_positive" CHECK ("reshare_order_lines"."quantity" > 0),
	CONSTRAINT "reshare_order_lines_reflected_range" CHECK ("reshare_order_lines"."supplier_reflected_quantity" >= 0 AND "reshare_order_lines"."supplier_reflected_quantity" <= "reshare_order_lines"."quantity")
);
--> statement-breakpoint
CREATE TABLE "reshare_order_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reshare_order_id" uuid NOT NULL,
	"reshare_order_line_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"allocation_line_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"settled_store_receipt_id" uuid,
	"settled_outbound_request_line_id" uuid,
	"received_quantity" integer,
	"shortage_quantity" integer,
	"shortage_check_id" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reshare_order_sources_quantity_positive" CHECK ("reshare_order_sources"."quantity" > 0),
	CONSTRAINT "reshare_order_sources_settlement" CHECK (("reshare_order_sources"."settled_at" IS NULL AND "reshare_order_sources"."settled_store_receipt_id" IS NULL AND "reshare_order_sources"."settled_outbound_request_line_id" IS NULL AND "reshare_order_sources"."received_quantity" IS NULL AND "reshare_order_sources"."shortage_quantity" IS NULL AND "reshare_order_sources"."shortage_check_id" IS NULL) OR ("reshare_order_sources"."settled_at" IS NOT NULL AND "reshare_order_sources"."settled_store_receipt_id" IS NOT NULL AND "reshare_order_sources"."settled_outbound_request_line_id" IS NOT NULL AND "reshare_order_sources"."received_quantity" >= 0 AND "reshare_order_sources"."shortage_quantity" >= 0 AND "reshare_order_sources"."received_quantity" + "reshare_order_sources"."shortage_quantity" = "reshare_order_sources"."quantity" AND (("reshare_order_sources"."shortage_quantity" > 0) = ("reshare_order_sources"."shortage_check_id" IS NOT NULL))))
);
--> statement-breakpoint
CREATE TABLE "reshare_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"allocation_decision_id" uuid NOT NULL,
	"allocation_run_id" uuid NOT NULL,
	"order_session_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "reshare_order_status" DEFAULT 'ordered' NOT NULL,
	"origin" text DEFAULT 'acceptance' NOT NULL,
	"store_name_snapshot" text NOT NULL,
	"session_code_snapshot" text NOT NULL,
	"total_quantity" integer NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"request_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reshare_orders_code_format" CHECK ("reshare_orders"."code" ~ '^RE-[0-9]{6}$'),
	CONSTRAINT "reshare_orders_total_positive" CHECK ("reshare_orders"."total_quantity" > 0),
	CONSTRAINT "reshare_orders_version_positive" CHECK ("reshare_orders"."version" > 0),
	CONSTRAINT "reshare_orders_origin_valid" CHECK ("reshare_orders"."origin" IN ('acceptance', 'backfill')),
	CONSTRAINT "reshare_orders_actor_role_valid" CHECK ("reshare_orders"."actor_role" IN ('store', 'wholesale', 'htkd', 'admin')),
	CONSTRAINT "reshare_orders_cancellation_recorded" CHECK (("reshare_orders"."status" = 'cancelled') = ("reshare_orders"."cancelled_at" IS NOT NULL AND "reshare_orders"."cancelled_by_user_id" IS NOT NULL AND length(btrim(coalesce("reshare_orders"."cancel_reason", ''))) >= 3))
);
--> statement-breakpoint
CREATE TABLE "supplier_observation_reshare_coverage" (
	"observation_id" uuid NOT NULL,
	"reshare_order_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_observation_reshare_coverage_observation_id_reshare_order_line_id_pk" PRIMARY KEY("observation_id","reshare_order_line_id"),
	CONSTRAINT "supplier_observation_reshare_coverage_quantity_positive" CHECK ("supplier_observation_reshare_coverage"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_stock_observation_lines" DROP CONSTRAINT "supplier_stock_observation_lines_formula";--> statement-breakpoint
DROP INDEX "warehouse_shortage_checks_receipt_line_uidx";--> statement-breakpoint
ALTER TABLE "supplier_stock_observation_lines" ADD COLUMN "issued_unreflected_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_stock_observation_lines" ADD COLUMN "reflected_reshare_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "warehouse_shortage_checks" ADD COLUMN "stock_mode" text DEFAULT 'held' NOT NULL;--> statement-breakpoint
ALTER TABLE "reshare_order_lines" ADD CONSTRAINT "reshare_order_lines_reshare_order_id_reshare_orders_id_fk" FOREIGN KEY ("reshare_order_id") REFERENCES "public"."reshare_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_lines" ADD CONSTRAINT "reshare_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_lines" ADD CONSTRAINT "reshare_order_lines_issue_ledger_entry_id_warehouse_ledger_entries_id_fk" FOREIGN KEY ("issue_ledger_entry_id") REFERENCES "public"."warehouse_ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_sources" ADD CONSTRAINT "reshare_order_sources_reshare_order_id_reshare_orders_id_fk" FOREIGN KEY ("reshare_order_id") REFERENCES "public"."reshare_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_sources" ADD CONSTRAINT "reshare_order_sources_reshare_order_line_id_reshare_order_lines_id_fk" FOREIGN KEY ("reshare_order_line_id") REFERENCES "public"."reshare_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_sources" ADD CONSTRAINT "reshare_order_sources_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_sources" ADD CONSTRAINT "reshare_order_sources_allocation_line_id_allocation_lines_id_fk" FOREIGN KEY ("allocation_line_id") REFERENCES "public"."allocation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_sources" ADD CONSTRAINT "reshare_order_sources_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_sources" ADD CONSTRAINT "reshare_order_sources_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_sources" ADD CONSTRAINT "reshare_order_sources_settled_store_receipt_id_store_receipts_id_fk" FOREIGN KEY ("settled_store_receipt_id") REFERENCES "public"."store_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_sources" ADD CONSTRAINT "reshare_order_sources_settled_outbound_request_line_id_outbound_request_lines_id_fk" FOREIGN KEY ("settled_outbound_request_line_id") REFERENCES "public"."outbound_request_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_order_sources" ADD CONSTRAINT "reshare_order_sources_shortage_check_id_warehouse_shortage_checks_id_fk" FOREIGN KEY ("shortage_check_id") REFERENCES "public"."warehouse_shortage_checks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_orders" ADD CONSTRAINT "reshare_orders_allocation_decision_id_allocation_result_decisions_id_fk" FOREIGN KEY ("allocation_decision_id") REFERENCES "public"."allocation_result_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_orders" ADD CONSTRAINT "reshare_orders_allocation_run_id_allocation_runs_id_fk" FOREIGN KEY ("allocation_run_id") REFERENCES "public"."allocation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_orders" ADD CONSTRAINT "reshare_orders_order_session_id_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."order_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_orders" ADD CONSTRAINT "reshare_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_orders" ADD CONSTRAINT "reshare_orders_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reshare_orders" ADD CONSTRAINT "reshare_orders_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_observation_reshare_coverage" ADD CONSTRAINT "supplier_observation_reshare_coverage_observation_id_supplier_stock_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."supplier_stock_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_observation_reshare_coverage" ADD CONSTRAINT "supplier_observation_reshare_coverage_reshare_order_line_id_reshare_order_lines_id_fk" FOREIGN KEY ("reshare_order_line_id") REFERENCES "public"."reshare_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_observation_reshare_coverage" ADD CONSTRAINT "supplier_observation_reshare_coverage_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reshare_order_lines_order_product_uidx" ON "reshare_order_lines" USING btree ("reshare_order_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reshare_order_lines_ledger_uidx" ON "reshare_order_lines" USING btree ("issue_ledger_entry_id");--> statement-breakpoint
CREATE INDEX "reshare_order_lines_product_unreflected_idx" ON "reshare_order_lines" USING btree ("product_id") WHERE "reshare_order_lines"."supplier_reflected_quantity" < "reshare_order_lines"."quantity";--> statement-breakpoint
CREATE UNIQUE INDEX "reshare_order_sources_reservation_uidx" ON "reshare_order_sources" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reshare_order_sources_allocation_line_uidx" ON "reshare_order_sources" USING btree ("allocation_line_id");--> statement-breakpoint
CREATE INDEX "reshare_order_sources_line_idx" ON "reshare_order_sources" USING btree ("reshare_order_line_id");--> statement-breakpoint
CREATE INDEX "reshare_order_sources_order_idx" ON "reshare_order_sources" USING btree ("reshare_order_id");--> statement-breakpoint
CREATE INDEX "reshare_order_sources_receipt_idx" ON "reshare_order_sources" USING btree ("settled_store_receipt_id") WHERE "reshare_order_sources"."settled_store_receipt_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reshare_orders_code_uidx" ON "reshare_orders" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "reshare_orders_decision_uidx" ON "reshare_orders" USING btree ("allocation_decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reshare_orders_run_store_uidx" ON "reshare_orders" USING btree ("allocation_run_id","store_id");--> statement-breakpoint
CREATE INDEX "reshare_orders_ordered_idx" ON "reshare_orders" USING btree ("ordered_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reshare_orders_store_ordered_idx" ON "reshare_orders" USING btree ("store_id","ordered_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reshare_orders_session_idx" ON "reshare_orders" USING btree ("order_session_id");--> statement-breakpoint
CREATE INDEX "supplier_observation_reshare_coverage_line_idx" ON "supplier_observation_reshare_coverage" USING btree ("reshare_order_line_id");--> statement-breakpoint
CREATE INDEX "reservations_outbound_line_idx" ON "reservations" USING btree ("outbound_request_line_id") WHERE "reservations"."outbound_request_line_id" IS NOT NULL AND "reservations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_shortage_checks_receipt_line_mode_uidx" ON "warehouse_shortage_checks" USING btree ("store_receipt_line_id","stock_mode") WHERE "warehouse_shortage_checks"."store_receipt_adjustment_line_id" IS NULL;--> statement-breakpoint
ALTER TABLE "supplier_stock_observation_lines" ADD CONSTRAINT "supplier_stock_observation_lines_formula" CHECK ("supplier_stock_observation_lines"."issued_unreflected_quantity" >= 0 AND "supplier_stock_observation_lines"."reflected_reshare_quantity" >= 0 AND "supplier_stock_observation_lines"."unordered_commitment_quantity" = "supplier_stock_observation_lines"."offer_hold_quantity" + "supplier_stock_observation_lines"."unordered_reserved_quantity" + "supplier_stock_observation_lines"."issued_unreflected_quantity" AND "supplier_stock_observation_lines"."effective_supplier_quantity" = "supplier_stock_observation_lines"."observed_quantity" + "supplier_stock_observation_lines"."pending_delta" AND "supplier_stock_observation_lines"."free_quantity" - "supplier_stock_observation_lines"."shortfall_quantity" = "supplier_stock_observation_lines"."effective_supplier_quantity" - "supplier_stock_observation_lines"."unordered_commitment_quantity" AND ("supplier_stock_observation_lines"."free_quantity" = 0 OR "supplier_stock_observation_lines"."shortfall_quantity" = 0));--> statement-breakpoint
ALTER TABLE "warehouse_shortage_checks" ADD CONSTRAINT "warehouse_shortage_checks_stock_mode_valid" CHECK ("warehouse_shortage_checks"."stock_mode" IN ('held', 'issued'));
--> statement-breakpoint
-- RE codes have their own fixed six-digit format; next_document_code() would derive seven
-- digits from the two-letter prefix, so it is deliberately not used here.
CREATE OR REPLACE FUNCTION next_reshare_order_code() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE allocated integer;
BEGIN
  INSERT INTO document_code_counters(prefix, last_number) VALUES ('RE', 1)
  ON CONFLICT (prefix) DO UPDATE
    SET last_number = document_code_counters.last_number + 1
  RETURNING last_number INTO allocated;
  IF allocated > 999999 THEN
    RAISE EXCEPTION 'RESHARE_ORDER_CODE_EXHAUSTED: the RE-000001..RE-999999 range is used up'
      USING ERRCODE = 'IDR01';
  END IF;
  RETURN 'RE-' || lpad(allocated::text, 6, '0');
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reshare_orders_validate_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE decision record;
BEGIN
  IF NEW.code IS NOT NULL AND NEW.code <> '' THEN
    RAISE EXCEPTION 'RE codes are assigned by the database only' USING ERRCODE = 'IDR02';
  END IF;
  SELECT d.* INTO decision FROM allocation_result_decisions d WHERE d.id = NEW.allocation_decision_id;
  IF NOT FOUND OR decision.status <> 'accepted'
    OR decision.allocation_run_id <> NEW.allocation_run_id
    OR decision.order_session_id <> NEW.order_session_id
    OR decision.store_id <> NEW.store_id
    -- Millisecond precision: application timestamps carry milliseconds, PostgreSQL microseconds.
    OR decision.responded_at IS NULL
    OR date_trunc('milliseconds', decision.responded_at)
      IS DISTINCT FROM date_trunc('milliseconds', NEW.accepted_at) THEN
    RAISE EXCEPTION 'an RE order needs the accepted allocation result it was created from'
      USING ERRCODE = 'IDR02';
  END IF;
  IF NEW.status <> 'ordered' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'an RE order starts ordered at version 1' USING ERRCODE = 'IDR02';
  END IF;
  NEW.code := next_reshare_order_code();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reshare_orders_validate_insert BEFORE INSERT ON reshare_orders
FOR EACH ROW EXECUTE FUNCTION reshare_orders_validate_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reshare_orders_protect_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RE orders are never deleted' USING ERRCODE = 'IDR03';
  END IF;
  IF NEW.id <> OLD.id OR NEW.code <> OLD.code
    OR NEW.allocation_decision_id <> OLD.allocation_decision_id
    OR NEW.allocation_run_id <> OLD.allocation_run_id
    OR NEW.order_session_id <> OLD.order_session_id OR NEW.store_id <> OLD.store_id
    OR NEW.origin <> OLD.origin OR NEW.store_name_snapshot <> OLD.store_name_snapshot
    OR NEW.session_code_snapshot <> OLD.session_code_snapshot
    OR NEW.total_quantity <> OLD.total_quantity OR NEW.accepted_at <> OLD.accepted_at
    OR NEW.ordered_at <> OLD.ordered_at OR NEW.actor_user_id <> OLD.actor_user_id
    OR NEW.actor_role <> OLD.actor_role OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'RE order identity, code and quantities are immutable' USING ERRCODE = 'IDR03';
  END IF;
  IF OLD.status = 'cancelled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a cancelled RE order is final' USING ERRCODE = 'IDR03';
  END IF;
  IF NEW.status <> OLD.status AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'an RE order status change increments its version' USING ERRCODE = 'IDR03';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reshare_orders_protect_history BEFORE UPDATE OR DELETE ON reshare_orders
FOR EACH ROW EXECUTE FUNCTION reshare_orders_protect_history();
--> statement-breakpoint
-- An RE line is valid only with the ledger entry that took exactly its quantity out of on-hand
-- and out of reserved for this order and product.
CREATE OR REPLACE FUNCTION reshare_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RE order lines are never deleted' USING ERRCODE = 'IDR03';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM warehouse_ledger_entries le
      WHERE le.id = NEW.issue_ledger_entry_id
        AND le.product_id = NEW.product_id
        AND le.source_type = 'reshare_order'
        AND le.source_id = NEW.reshare_order_id
        AND le.on_hand_delta = -NEW.quantity
        AND le.reserved_delta = -NEW.quantity
    ) THEN
      RAISE EXCEPTION 'RE order line % has no matching issue ledger entry', NEW.id
        USING ERRCODE = 'IDR04';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.reshare_order_id <> OLD.reshare_order_id
    OR NEW.product_id <> OLD.product_id OR NEW.quantity <> OLD.quantity
    OR NEW.issue_ledger_entry_id <> OLD.issue_ledger_entry_id
    OR NEW.product_name_snapshot <> OLD.product_name_snapshot
    OR NEW.product_sku_snapshot <> OLD.product_sku_snapshot
    OR NEW.created_at <> OLD.created_at
    OR NEW.supplier_reflected_quantity < OLD.supplier_reflected_quantity THEN
    RAISE EXCEPTION 'RE order line % is immutable except for growing source coverage', OLD.id
      USING ERRCODE = 'IDR03';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reshare_order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON reshare_order_lines
FOR EACH ROW EXECUTE FUNCTION reshare_order_lines_guard();
--> statement-breakpoint
-- A source names one hold of the order's own allocation result, already marked issued, with the
-- same store, product and quantity. It is settled at most once, by the receipt.
CREATE OR REPLACE FUNCTION reshare_order_sources_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RE order sources are never deleted' USING ERRCODE = 'IDR03';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.settled_at IS NOT NULL OR NOT EXISTS (
      SELECT 1
      FROM reservations r
      JOIN allocation_lines al ON al.id = r.allocation_line_id
      JOIN reshare_order_lines ol ON ol.id = NEW.reshare_order_line_id
      JOIN reshare_orders o ON o.id = ol.reshare_order_id
      WHERE r.id = NEW.reservation_id
        AND r.status = 'issued'
        AND r.deleted_at IS NULL
        AND r.allocation_line_id = NEW.allocation_line_id
        AND r.store_id = NEW.store_id
        AND r.product_id = NEW.product_id
        AND r.quantity = NEW.quantity
        AND ol.product_id = NEW.product_id
        AND o.id = NEW.reshare_order_id
        AND o.store_id = NEW.store_id
        AND al.allocation_run_id = o.allocation_run_id
        AND al.store_id = o.store_id
    ) THEN
      RAISE EXCEPTION 'RE order source % does not match an issued hold of its result', NEW.id
        USING ERRCODE = 'IDR04';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.reshare_order_id <> OLD.reshare_order_id
    OR NEW.reshare_order_line_id <> OLD.reshare_order_line_id
    OR NEW.reservation_id <> OLD.reservation_id
    OR NEW.allocation_line_id <> OLD.allocation_line_id OR NEW.store_id <> OLD.store_id
    OR NEW.product_id <> OLD.product_id OR NEW.quantity <> OLD.quantity
    OR NEW.created_at <> OLD.created_at
    OR (OLD.settled_at IS NOT NULL AND (
      NEW.settled_at IS DISTINCT FROM OLD.settled_at
      OR NEW.settled_store_receipt_id IS DISTINCT FROM OLD.settled_store_receipt_id
      OR NEW.settled_outbound_request_line_id IS DISTINCT FROM OLD.settled_outbound_request_line_id
      OR NEW.received_quantity IS DISTINCT FROM OLD.received_quantity
      OR NEW.shortage_quantity IS DISTINCT FROM OLD.shortage_quantity
      OR NEW.shortage_check_id IS DISTINCT FROM OLD.shortage_check_id
    )) THEN
    RAISE EXCEPTION 'RE order source % is immutable once settled', OLD.id USING ERRCODE = 'IDR03';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reshare_order_sources_guard BEFORE INSERT OR UPDATE OR DELETE ON reshare_order_sources
FOR EACH ROW EXECUTE FUNCTION reshare_order_sources_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION supplier_observation_reshare_coverage_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'supplier observation RE coverage is immutable' USING ERRCODE = 'IDR03';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER supplier_observation_reshare_coverage_immutable
BEFORE UPDATE OR DELETE ON supplier_observation_reshare_coverage
FOR EACH ROW EXECUTE FUNCTION supplier_observation_reshare_coverage_immutable();
--> statement-breakpoint
-- Checked at commit: an issued hold always has its unsettled RE source, and a hold with an RE
-- source only leaves 'issued' when the receipt settled that source. Direct SQL that flips a
-- status without the RE document and ledger entry cannot commit.
CREATE OR REPLACE FUNCTION reservations_issuance_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'issued' THEN
    IF NOT EXISTS (
      SELECT 1 FROM reshare_order_sources s
      WHERE s.reservation_id = NEW.id AND s.settled_at IS NULL
    ) THEN
      RAISE EXCEPTION 'issued reservation % has no unsettled RE order source', NEW.id
        USING ERRCODE = 'IDR05';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM reshare_order_sources s
    WHERE s.reservation_id = NEW.id AND s.settled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'reservation % left issued without its receipt settlement', NEW.id
      USING ERRCODE = 'IDR05';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER reservations_issuance_consistency
AFTER INSERT OR UPDATE ON reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reservations_issuance_consistency();
--> statement-breakpoint
-- Checked at commit: an answer that accepts new goods always created its RE order and issue.
-- A release that does not know RE orders (an older image during deploy or rollback) therefore
-- cannot accept a result; it fails closed instead of leaving goods accepted but not issued.
CREATE OR REPLACE FUNCTION allocation_acceptance_requires_reshare_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reshare_orders o WHERE o.allocation_decision_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'RESHARE_ORDER_REQUIRED: accepted allocation result % has no RE order', NEW.id
      USING ERRCODE = 'IDR06';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER allocation_acceptance_requires_reshare_order
AFTER UPDATE OF status ON allocation_result_decisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.status = 'accepted' AND OLD.status = 'pending')
EXECUTE FUNCTION allocation_acceptance_requires_reshare_order();
--> statement-breakpoint
-- Receipt finalization guard (replaces the 0032 body). Every check is kept; the warehouse ledger
-- evidence is now per source: goods issued with an RE order were already deducted when the order
-- was created, so only the legacy remainder of a line (held until receipt) may and must carry the
-- store_receipt deduction. A line issued in full has no store_receipt entry at all.
CREATE OR REPLACE FUNCTION validate_store_receipt_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
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
          ((l.received_quantity + l.excess_quantity) > 0 AND l.price_per_kg_vnd IS NULL)
          OR (SELECT count(*) FROM store_receipt_bags b WHERE b.store_receipt_line_id = l.id) <> l.received_quantity + l.excess_quantity
          OR l.goods_cost_vnd <> COALESCE((SELECT sum(b.goods_cost_vnd) FROM store_receipt_bags b WHERE b.store_receipt_line_id = l.id), 0)
          OR EXISTS (
            SELECT 1 FROM store_receipt_bags b
            WHERE b.store_receipt_line_id = l.id
              AND (
                ((l.outbound_request_line_id IS NULL OR b.bag_number <= l.received_quantity)
                  AND b.price_per_kg_vnd IS DISTINCT FROM l.price_per_kg_vnd)
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
      WHERE l.store_receipt_id = NEW.id AND r.status IN ('active', 'issued') AND r.deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      JOIN outbound_request_lines ol ON ol.id = l.outbound_request_line_id
      WHERE l.store_receipt_id = NEW.id AND ol.received_quantity <> l.received_quantity
    ) OR EXISTS (
      SELECT 1
      FROM store_receipt_lines l
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(s.quantity), 0)::integer AS issued_quantity,
               COALESCE(sum(s.received_quantity), 0)::integer AS issued_received
        FROM reshare_order_sources s
        WHERE s.settled_store_receipt_id = NEW.id
          AND s.settled_outbound_request_line_id = l.outbound_request_line_id
      ) issued
      WHERE l.store_receipt_id = NEW.id
        AND l.outbound_request_line_id IS NOT NULL
        AND (
          issued.issued_quantity > l.approved_quantity
          OR issued.issued_received > l.received_quantity
          OR (l.received_quantity - issued.issued_received) > (l.approved_quantity - issued.issued_quantity)
          OR (
            l.approved_quantity > issued.issued_quantity
            AND NOT EXISTS (
              SELECT 1 FROM warehouse_ledger_entries le
              WHERE le.source_type = 'store_receipt'
                AND le.source_id = NEW.id
                AND le.product_id = l.product_id
                AND le.on_hand_delta = -(l.received_quantity - issued.issued_received)
                AND le.reserved_delta = -(l.approved_quantity - issued.issued_quantity)
            )
          )
          OR (
            l.approved_quantity = issued.issued_quantity
            AND EXISTS (
              SELECT 1 FROM warehouse_ledger_entries le
              WHERE le.source_type = 'store_receipt'
                AND le.source_id = NEW.id
                AND le.product_id = l.product_id
            )
          )
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
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id AND l.excess_quantity > 0
        AND (NOT EXISTS (
          SELECT 1 FROM warehouse_ledger_entries le
          WHERE le.source_type = 'store_receipt_excess' AND le.source_id = NEW.id
            AND le.product_id = l.product_id AND le.on_hand_delta = -l.excess_quantity
            AND le.reserved_delta = 0
        ) OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(NEW.unexpected_items) item
          WHERE item->>'productId' = l.product_id::text
            AND (item->>'quantity')::integer = l.excess_quantity
        ))
    ) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.unexpected_items) item
      WHERE NOT EXISTS (
        SELECT 1 FROM store_receipt_lines l WHERE l.store_receipt_id = NEW.id
          AND l.product_id::text = item->>'productId'
          AND l.excess_quantity = (item->>'quantity')::integer
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
$$;
