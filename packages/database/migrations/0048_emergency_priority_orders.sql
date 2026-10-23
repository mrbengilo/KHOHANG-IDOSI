CREATE SEQUENCE emergency_priority_order_code_seq MAXVALUE 99999999;
--> statement-breakpoint
CREATE TABLE "emergency_priority_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text DEFAULT 'UK-' || lpad(nextval('emergency_priority_order_code_seq')::text, 8, '0') NOT NULL,
	"store_id" uuid NOT NULL,
	"outbound_request_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_name" text NOT NULL,
	"store_name" text NOT NULL,
	"total_quantity" integer NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"reshare_status" text DEFAULT 'ORDERED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emergency_priority_orders_quantity" CHECK ("emergency_priority_orders"."total_quantity" > 0 AND "emergency_priority_orders"."total_quantity" <= 10000),
	CONSTRAINT "emergency_priority_orders_version" CHECK ("emergency_priority_orders"."version" > 0),
	CONSTRAINT "emergency_priority_orders_reshare_status" CHECK ("emergency_priority_orders"."reshare_status" IN ('ORDERED','NOT_ORDERED'))
);
--> statement-breakpoint
CREATE TABLE "emergency_priority_sources" (
	"order_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "emergency_priority_sources_order_id_reservation_id_pk" PRIMARY KEY("order_id","reservation_id"),
	CONSTRAINT "emergency_priority_sources_kind" CHECK ("emergency_priority_sources"."kind" IN ('held','additional'))
);
--> statement-breakpoint
ALTER TABLE "reshare_orders" DROP CONSTRAINT "reshare_orders_origin_valid";--> statement-breakpoint
ALTER TABLE "reshare_order_sources" ALTER COLUMN "allocation_line_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reshare_orders" ALTER COLUMN "allocation_decision_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reshare_orders" ALTER COLUMN "allocation_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reshare_orders" ALTER COLUMN "order_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reshare_orders" ADD COLUMN "emergency_order_id" uuid;--> statement-breakpoint
ALTER TABLE "emergency_priority_orders" ADD CONSTRAINT "emergency_priority_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_priority_orders" ADD CONSTRAINT "emergency_priority_orders_outbound_request_id_outbound_requests_id_fk" FOREIGN KEY ("outbound_request_id") REFERENCES "public"."outbound_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_priority_orders" ADD CONSTRAINT "emergency_priority_orders_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_priority_sources" ADD CONSTRAINT "emergency_priority_sources_order_id_emergency_priority_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."emergency_priority_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_priority_sources" ADD CONSTRAINT "emergency_priority_sources_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "emergency_priority_orders_code_uidx" ON "emergency_priority_orders" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "emergency_priority_orders_outbound_uidx" ON "emergency_priority_orders" USING btree ("outbound_request_id");--> statement-breakpoint
CREATE INDEX "emergency_priority_orders_store_time_idx" ON "emergency_priority_orders" USING btree ("store_id","approved_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE UNIQUE INDEX "emergency_priority_sources_reservation_uidx" ON "emergency_priority_sources" USING btree ("reservation_id");--> statement-breakpoint
ALTER TABLE "reshare_orders" ADD CONSTRAINT "reshare_orders_emergency_order_id_emergency_priority_orders_id_fk" FOREIGN KEY ("emergency_order_id") REFERENCES "public"."emergency_priority_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reshare_orders_emergency_uidx" ON "reshare_orders" USING btree ("emergency_order_id");--> statement-breakpoint
ALTER TABLE "reshare_orders" ADD CONSTRAINT "reshare_orders_source_kind" CHECK (("reshare_orders"."origin" = 'emergency' AND "reshare_orders"."emergency_order_id" IS NOT NULL AND "reshare_orders"."allocation_decision_id" IS NULL AND "reshare_orders"."allocation_run_id" IS NULL AND "reshare_orders"."order_session_id" IS NULL) OR ("reshare_orders"."origin" <> 'emergency' AND "reshare_orders"."emergency_order_id" IS NULL AND "reshare_orders"."allocation_decision_id" IS NOT NULL AND "reshare_orders"."allocation_run_id" IS NOT NULL AND "reshare_orders"."order_session_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "reshare_orders" ADD CONSTRAINT "reshare_orders_origin_valid" CHECK ("reshare_orders"."origin" IN ('acceptance', 'backfill', 'emergency'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reshare_orders_validate_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE decision record;
BEGIN
  IF NEW.code IS NOT NULL AND NEW.code <> '' THEN
    RAISE EXCEPTION 'RE codes are assigned by the database only' USING ERRCODE = 'IDR02';
  END IF;
  IF NEW.origin = 'emergency' THEN
    IF NEW.status <> 'ordered' OR NEW.version <> 1 OR NOT EXISTS (
      SELECT 1 FROM emergency_priority_orders e JOIN users u ON u.id=e.actor_user_id
      WHERE e.id=NEW.emergency_order_id AND e.store_id=NEW.store_id
        AND e.actor_user_id=NEW.actor_user_id AND u.role::text=NEW.actor_role
        AND u.role IN ('admin','htkd') AND u.status='active' AND u.deleted_at IS NULL
        AND date_trunc('milliseconds',e.approved_at)=date_trunc('milliseconds',NEW.accepted_at)
    ) THEN RAISE EXCEPTION 'Invalid emergency RE source' USING ERRCODE='IDR02'; END IF;
    NEW.code := next_reshare_order_code(); RETURN NEW;
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
CREATE OR REPLACE FUNCTION reshare_orders_protect_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RE orders are never deleted' USING ERRCODE = 'IDR03';
  END IF;
  IF NEW.emergency_order_id IS DISTINCT FROM OLD.emergency_order_id OR NEW.id <> OLD.id OR NEW.code <> OLD.code
    OR NEW.allocation_decision_id IS DISTINCT FROM OLD.allocation_decision_id
    OR NEW.allocation_run_id IS DISTINCT FROM OLD.allocation_run_id
    OR NEW.order_session_id IS DISTINCT FROM OLD.order_session_id OR NEW.store_id <> OLD.store_id
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
      LEFT JOIN allocation_lines al ON al.id = r.allocation_line_id
      JOIN reshare_order_lines ol ON ol.id = NEW.reshare_order_line_id
      JOIN reshare_orders o ON o.id = ol.reshare_order_id
      WHERE r.id = NEW.reservation_id
        AND r.status = 'issued'
        AND r.deleted_at IS NULL
        AND r.allocation_line_id IS NOT DISTINCT FROM NEW.allocation_line_id
        AND r.store_id = NEW.store_id
        AND r.product_id = NEW.product_id
        AND r.quantity = NEW.quantity
        AND ol.product_id = NEW.product_id
        AND o.id = NEW.reshare_order_id
        AND o.store_id = NEW.store_id
        AND ((o.origin <> 'emergency' AND al.allocation_run_id = o.allocation_run_id AND al.store_id = o.store_id)
          OR (o.origin='emergency' AND EXISTS (
            SELECT 1 FROM emergency_priority_sources es JOIN emergency_priority_orders e ON e.id=es.order_id
            JOIN outbound_request_lines ol2 ON ol2.outbound_request_id=e.outbound_request_id
            WHERE es.order_id=o.emergency_order_id AND es.reservation_id=r.id
              AND ol2.id=r.outbound_request_line_id AND ol2.product_id=r.product_id AND e.store_id=r.store_id
          )))
    ) THEN
      RAISE EXCEPTION 'RE order source % does not match an issued hold of its result', NEW.id
        USING ERRCODE = 'IDR04';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.reshare_order_id <> OLD.reshare_order_id
    OR NEW.reshare_order_line_id <> OLD.reshare_order_line_id
    OR NEW.reservation_id <> OLD.reservation_id
    OR NEW.allocation_line_id IS DISTINCT FROM OLD.allocation_line_id OR NEW.store_id <> OLD.store_id
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
CREATE FUNCTION emergency_priority_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reshare_orders re WHERE re.emergency_order_id=NEW.id)
     OR NOT EXISTS (SELECT 1 FROM outbound_requests o WHERE o.id=NEW.outbound_request_id AND o.store_id=NEW.store_id AND o.status='dispatched' AND o.allocation_run_id IS NULL AND o.order_session_id IS NULL)
     OR NEW.total_quantity <> (SELECT coalesce(sum(r.quantity),0) FROM emergency_priority_sources s JOIN reservations r ON r.id=s.reservation_id WHERE s.order_id=NEW.id)
     OR EXISTS (SELECT 1 FROM emergency_priority_sources s JOIN reservations r ON r.id=s.reservation_id LEFT JOIN outbound_request_lines ol ON ol.id=r.outbound_request_line_id WHERE s.order_id=NEW.id AND (r.status<>'issued' OR r.store_id<>NEW.store_id OR ol.outbound_request_id IS DISTINCT FROM NEW.outbound_request_id OR ol.product_id IS DISTINCT FROM r.product_id))
  THEN RAISE EXCEPTION 'Incomplete emergency order' USING ERRCODE='IDR04'; END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER emergency_priority_complete AFTER INSERT ON emergency_priority_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION emergency_priority_complete();

--> statement-breakpoint
-- Deferred checks must inspect the final row: an emergency transaction reserves then issues.
CREATE OR REPLACE FUNCTION reservations_issuance_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_row reservations%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM reservations WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF current_row.status = 'issued' THEN
    IF NOT EXISTS (SELECT 1 FROM reshare_order_sources s WHERE s.reservation_id=current_row.id AND s.settled_at IS NULL) THEN
      RAISE EXCEPTION 'issued reservation % has no unsettled RE source', current_row.id USING ERRCODE='IDR05';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM reshare_order_sources s WHERE s.reservation_id=current_row.id AND s.settled_at IS NULL) THEN
    RAISE EXCEPTION 'reservation % left issued without its receipt settlement', current_row.id USING ERRCODE='IDR05';
  END IF;
  RETURN NULL;
END; $$;

--> statement-breakpoint
-- Emergency shortages use receipt discrepancy checks, without generating wait demand.
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
      -- The shortage is queued when the store submits, often days before HTKD finalizes; by then
      -- its wait may already be allocated, cancelled or merged. What must hold is that this
      -- receipt recorded the queued shortage and the demand reached the store's waitlist.
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id
        AND l.received_quantity < l.approved_quantity
        AND (
          EXISTS (SELECT 1 FROM emergency_priority_orders e WHERE e.outbound_request_id=NEW.outbound_request_id) AND l.priority_queued_quantity <> 0
          OR (NOT EXISTS (SELECT 1 FROM emergency_priority_orders e WHERE e.outbound_request_id=NEW.outbound_request_id) AND (l.priority_queued_quantity <> l.approved_quantity - l.received_quantity
          OR NOT EXISTS (
            SELECT 1 FROM wait_tickets w
            WHERE w.store_id = NEW.store_id
              AND w.product_id = l.product_id
              AND w.deleted_at IS NULL
          )))
        )
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id AND l.excess_quantity > 0
        -- Exactly one booking: out of A's unreserved stock, or, for a Reshare-reconciled SKU,
        -- no A deduction (B already counted it) and the SKU flagged for a new observation.
        AND (EXISTS (
          SELECT 1 FROM warehouse_ledger_entries le
          WHERE le.source_type = 'store_receipt_excess' AND le.source_id = NEW.id
            AND le.product_id = l.product_id AND le.on_hand_delta = -l.excess_quantity
            AND le.reserved_delta = 0
        ) = EXISTS (
          SELECT 1 FROM audit_logs a
          WHERE a.action = 'SUPPLIER_RECEIPT_EXCESS_NEEDS_RECONCILIATION'
            AND a.entity_type = 'store_receipt' AND a.entity_id = NEW.id
            AND a.after->>'productId' = l.product_id::text
            AND (a.after->>'quantity')::integer = l.excess_quantity
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

--> statement-breakpoint
CREATE FUNCTION emergency_priority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Emergency order history cannot be deleted' USING ERRCODE='IDR03'; END IF;
  IF TG_TABLE_NAME='emergency_priority_sources' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Emergency ownership is immutable' USING ERRCODE='IDR03'; END IF;
  ELSIF (to_jsonb(NEW)-'version'-'reshare_status') IS DISTINCT FROM (to_jsonb(OLD)-'version'-'reshare_status') OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Emergency order identity is immutable; status updates increment version' USING ERRCODE='IDR03';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER emergency_priority_orders_immutable BEFORE UPDATE OR DELETE ON emergency_priority_orders FOR EACH ROW EXECUTE FUNCTION emergency_priority_immutable();
--> statement-breakpoint
CREATE TRIGGER emergency_priority_sources_immutable BEFORE UPDATE OR DELETE ON emergency_priority_sources FOR EACH ROW EXECUTE FUNCTION emergency_priority_immutable();
