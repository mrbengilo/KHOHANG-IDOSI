-- Expand-only release (docs/allocation-waitlist-workflow.md).
-- 1. "Chuyển phiếu chờ": a PENDING allocation result can be moved back to wait tickets
--    (status waitlisted). The retired "Từ chối" (pending -> rejected) is refused from now on;
--    historical rejected rows stay readable.
-- 2. Cancelling a wait ticket revokes the goods of that ticket still sitting in PENDING results
--    (no RE order, not shipped). allocation_line_dispositions records each revoked line once;
--    allocation_result_decisions.revoked_quantity is their sum and the granted snapshot never
--    changes. A result whose every granted bag is revoked is closed as cancelled.
-- 3. wait_ticket_sources: append-only lineage of later contributions to a ticket's demand.
--    Older tickets get legacy_unsourced_quantity = original_quantity (their sessions cannot be
--    proven); nothing is invented and no stock, reservation, result or RE order is rewritten.
-- New enum values are compared as text in checks and only used inside trigger bodies (evaluated at
-- run time, after this migration commits), never by DDL that casts to the enum in this
-- transaction.
ALTER TYPE "public"."allocation_decision_status" ADD VALUE 'waitlisted';--> statement-breakpoint
ALTER TYPE "public"."allocation_decision_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "allocation_line_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_decision_id" uuid NOT NULL,
	"allocation_line_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"wait_ticket_id" uuid,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_line_dispositions_quantity_positive" CHECK ("allocation_line_dispositions"."quantity" > 0),
	CONSTRAINT "allocation_line_dispositions_kind_valid" CHECK ("allocation_line_dispositions"."kind" IN ('wait_ticket_cancelled', 'waitlisted')),
	CONSTRAINT "allocation_line_dispositions_cancel_has_ticket" CHECK ("allocation_line_dispositions"."kind" <> 'wait_ticket_cancelled' OR "allocation_line_dispositions"."wait_ticket_id" IS NOT NULL),
	CONSTRAINT "allocation_line_dispositions_actor_role_valid" CHECK ("allocation_line_dispositions"."actor_role" IN ('store', 'wholesale', 'htkd', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "wait_ticket_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wait_ticket_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"order_session_id" uuid,
	"allocation_run_id" uuid,
	"allocation_decision_id" uuid,
	"allocation_line_id" uuid,
	"source_wait_ticket_id" uuid,
	"order_request_item_id" uuid,
	"store_receipt_id" uuid,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wait_ticket_sources_quantity_positive" CHECK ("wait_ticket_sources"."quantity" > 0),
	CONSTRAINT "wait_ticket_sources_kind_valid" CHECK ("wait_ticket_sources"."kind" IN ('order_remainder', 'result_waitlisted', 'result_restored')),
	CONSTRAINT "wait_ticket_sources_result_lineage" CHECK ("wait_ticket_sources"."kind" NOT IN ('result_waitlisted', 'result_restored') OR ("wait_ticket_sources"."allocation_decision_id" IS NOT NULL AND "wait_ticket_sources"."allocation_line_id" IS NOT NULL AND "wait_ticket_sources"."actor_user_id" IS NOT NULL)),
	CONSTRAINT "wait_ticket_sources_restore_names_ticket" CHECK ("wait_ticket_sources"."kind" <> 'result_restored' OR "wait_ticket_sources"."source_wait_ticket_id" = "wait_ticket_sources"."wait_ticket_id")
);
--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" DROP CONSTRAINT "allocation_result_decisions_pending_has_goods";--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" DROP CONSTRAINT "allocation_result_decisions_answer_recorded";--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" ADD COLUMN "revoked_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD COLUMN "legacy_unsourced_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "allocation_line_dispositions" ADD CONSTRAINT "allocation_line_dispositions_allocation_decision_id_allocation_result_decisions_id_fk" FOREIGN KEY ("allocation_decision_id") REFERENCES "public"."allocation_result_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_line_dispositions" ADD CONSTRAINT "allocation_line_dispositions_allocation_line_id_allocation_lines_id_fk" FOREIGN KEY ("allocation_line_id") REFERENCES "public"."allocation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_line_dispositions" ADD CONSTRAINT "allocation_line_dispositions_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_line_dispositions" ADD CONSTRAINT "allocation_line_dispositions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_line_dispositions" ADD CONSTRAINT "allocation_line_dispositions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_line_dispositions" ADD CONSTRAINT "allocation_line_dispositions_wait_ticket_id_wait_tickets_id_fk" FOREIGN KEY ("wait_ticket_id") REFERENCES "public"."wait_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_line_dispositions" ADD CONSTRAINT "allocation_line_dispositions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_ticket_sources" ADD CONSTRAINT "wait_ticket_sources_wait_ticket_id_wait_tickets_id_fk" FOREIGN KEY ("wait_ticket_id") REFERENCES "public"."wait_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_ticket_sources" ADD CONSTRAINT "wait_ticket_sources_order_session_id_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."order_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_ticket_sources" ADD CONSTRAINT "wait_ticket_sources_allocation_run_id_allocation_runs_id_fk" FOREIGN KEY ("allocation_run_id") REFERENCES "public"."allocation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_ticket_sources" ADD CONSTRAINT "wait_ticket_sources_allocation_decision_id_allocation_result_decisions_id_fk" FOREIGN KEY ("allocation_decision_id") REFERENCES "public"."allocation_result_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_ticket_sources" ADD CONSTRAINT "wait_ticket_sources_allocation_line_id_allocation_lines_id_fk" FOREIGN KEY ("allocation_line_id") REFERENCES "public"."allocation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_ticket_sources" ADD CONSTRAINT "wait_ticket_sources_source_wait_ticket_id_wait_tickets_id_fk" FOREIGN KEY ("source_wait_ticket_id") REFERENCES "public"."wait_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_ticket_sources" ADD CONSTRAINT "wait_ticket_sources_order_request_item_id_order_request_items_id_fk" FOREIGN KEY ("order_request_item_id") REFERENCES "public"."order_request_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_ticket_sources" ADD CONSTRAINT "wait_ticket_sources_store_receipt_id_store_receipts_id_fk" FOREIGN KEY ("store_receipt_id") REFERENCES "public"."store_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_ticket_sources" ADD CONSTRAINT "wait_ticket_sources_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_line_dispositions_line_uidx" ON "allocation_line_dispositions" USING btree ("allocation_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_line_dispositions_reservation_uidx" ON "allocation_line_dispositions" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "allocation_line_dispositions_decision_idx" ON "allocation_line_dispositions" USING btree ("allocation_decision_id");--> statement-breakpoint
CREATE INDEX "allocation_line_dispositions_wait_ticket_idx" ON "allocation_line_dispositions" USING btree ("wait_ticket_id") WHERE "allocation_line_dispositions"."wait_ticket_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wait_ticket_sources_allocation_line_uidx" ON "wait_ticket_sources" USING btree ("allocation_line_id") WHERE "wait_ticket_sources"."allocation_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wait_ticket_sources_ticket_idx" ON "wait_ticket_sources" USING btree ("wait_ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "wait_ticket_sources_decision_idx" ON "wait_ticket_sources" USING btree ("allocation_decision_id") WHERE "wait_ticket_sources"."allocation_decision_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" ADD CONSTRAINT "allocation_result_decisions_revoked_range" CHECK ("allocation_result_decisions"."revoked_quantity" >= 0 AND "allocation_result_decisions"."revoked_quantity" <= "allocation_result_decisions"."granted_quantity");--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" ADD CONSTRAINT "allocation_result_decisions_revocation_state" CHECK (("allocation_result_decisions"."status"::text IN ('pending', 'accepted') AND "allocation_result_decisions"."revoked_quantity" < "allocation_result_decisions"."granted_quantity") OR ("allocation_result_decisions"."status"::text IN ('waitlisted', 'cancelled') AND "allocation_result_decisions"."revoked_quantity" = "allocation_result_decisions"."granted_quantity") OR ("allocation_result_decisions"."status"::text NOT IN ('pending', 'accepted', 'waitlisted', 'cancelled') AND "allocation_result_decisions"."revoked_quantity" = 0));--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" ADD CONSTRAINT "allocation_result_decisions_pending_has_goods" CHECK ("allocation_result_decisions"."status"::text NOT IN ('pending', 'accepted', 'rejected', 'waitlisted', 'cancelled') OR "allocation_result_decisions"."granted_quantity" > 0);--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" ADD CONSTRAINT "allocation_result_decisions_answer_recorded" CHECK (("allocation_result_decisions"."status"::text IN ('accepted', 'rejected', 'waitlisted')) = ("allocation_result_decisions"."responded_at" IS NOT NULL AND "allocation_result_decisions"."responded_by_user_id" IS NOT NULL));--> statement-breakpoint
UPDATE "wait_tickets" SET "legacy_unsourced_quantity" = "original_quantity" WHERE "legacy_unsourced_quantity" = 0;--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD CONSTRAINT "wait_tickets_legacy_unsourced_range" CHECK ("wait_tickets"."legacy_unsourced_quantity" >= 0);--> statement-breakpoint
-- Replaces the 0038 body. Identity and granted snapshot stay immutable; a pending result moves
-- once to accepted or waitlisted (an answer) or to cancelled (every bag revoked), and may only
-- grow its revoked quantity while pending, each time with a new version.
CREATE OR REPLACE FUNCTION allocation_result_decisions_protect_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'allocation_result_decisions rows are never deleted' USING ERRCODE = 'IDA03';
  END IF;
  IF NEW.id <> OLD.id OR NEW.allocation_run_id <> OLD.allocation_run_id
    OR NEW.order_session_id <> OLD.order_session_id OR NEW.store_id <> OLD.store_id
    OR NEW.granted_quantity <> OLD.granted_quantity OR NEW.origin <> OLD.origin
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'allocation result identity and granted snapshot are immutable' USING ERRCODE = 'IDA03';
  END IF;
  IF NEW.revoked_quantity < OLD.revoked_quantity THEN
    RAISE EXCEPTION 'revoked goods of allocation result % never come back', OLD.id USING ERRCODE = 'IDA03';
  END IF;
  IF OLD.status::text <> 'pending' THEN
    IF NEW.status <> OLD.status OR NEW.version <> OLD.version
      OR NEW.revoked_quantity <> OLD.revoked_quantity
      OR NEW.responded_at IS DISTINCT FROM OLD.responded_at
      OR NEW.responded_by_user_id IS DISTINCT FROM OLD.responded_by_user_id
      OR NEW.response_reason IS DISTINCT FROM OLD.response_reason THEN
      RAISE EXCEPTION 'allocation result decision % is final', OLD.id USING ERRCODE = 'IDA03';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status::text = 'pending' THEN
    IF NEW.revoked_quantity <> OLD.revoked_quantity AND NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'revoking goods of allocation result % needs a new version', OLD.id
        USING ERRCODE = 'IDA03';
    END IF;
    IF NEW.revoked_quantity = OLD.revoked_quantity AND NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'allocation result % version changes only with its goods or answer', OLD.id
        USING ERRCODE = 'IDA03';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'pending allocation result decision % moves once, with a new version', OLD.id
      USING ERRCODE = 'IDA03';
  END IF;
  IF NEW.status::text = 'accepted' AND NEW.revoked_quantity = OLD.revoked_quantity THEN
    RETURN NEW;
  END IF;
  IF NEW.status::text IN ('waitlisted', 'cancelled') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pending allocation result decision % can only be accepted, moved to waiting or cancelled (rejection was retired by 0044)', OLD.id
    USING ERRCODE = 'IDA03';
END;
$$;--> statement-breakpoint
-- Checked at commit: the revoked quantity of a result is exactly the sum of its dispositions,
-- and every disposition names a released hold of its own result that no RE order issued.
CREATE OR REPLACE FUNCTION allocation_line_dispositions_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME = 'allocation_line_dispositions' THEN
    target := NEW.allocation_decision_id;
    IF NOT EXISTS (
      SELECT 1
      FROM reservations r
      JOIN allocation_lines al ON al.id = r.allocation_line_id
      JOIN allocation_result_decisions d ON d.id = NEW.allocation_decision_id
      WHERE r.id = NEW.reservation_id
        AND r.allocation_line_id = NEW.allocation_line_id
        AND r.status::text = 'released'
        AND r.quantity = NEW.quantity
        AND r.store_id = NEW.store_id
        AND r.product_id = NEW.product_id
        AND al.allocation_run_id = d.allocation_run_id
        AND al.store_id = d.store_id
        AND al.wait_ticket_id IS NOT DISTINCT FROM NEW.wait_ticket_id
    ) OR EXISTS (
      SELECT 1 FROM reshare_order_sources s WHERE s.allocation_line_id = NEW.allocation_line_id
    ) THEN
      RAISE EXCEPTION 'disposition % does not match a released, unissued hold of its result', NEW.id
        USING ERRCODE = 'IDA04';
    END IF;
  ELSE
    target := NEW.id;
  END IF;
  IF (SELECT d.revoked_quantity FROM allocation_result_decisions d WHERE d.id = target)
    IS DISTINCT FROM (
      SELECT coalesce(sum(x.quantity), 0)::integer FROM allocation_line_dispositions x
      WHERE x.allocation_decision_id = target
    ) THEN
    RAISE EXCEPTION 'revoked quantity of allocation result % does not match its dispositions', target
      USING ERRCODE = 'IDA04';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER allocation_line_dispositions_consistency
AFTER INSERT ON allocation_line_dispositions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION allocation_line_dispositions_consistency();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER allocation_result_decisions_revoked_consistency
AFTER UPDATE OF revoked_quantity ON allocation_result_decisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.revoked_quantity IS DISTINCT FROM OLD.revoked_quantity)
EXECUTE FUNCTION allocation_line_dispositions_consistency();--> statement-breakpoint
CREATE OR REPLACE FUNCTION allocation_waitlist_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only history', TG_TABLE_NAME USING ERRCODE = 'IDA03';
END;
$$;--> statement-breakpoint
CREATE TRIGGER allocation_line_dispositions_append_only
BEFORE UPDATE OR DELETE ON allocation_line_dispositions
FOR EACH ROW EXECUTE FUNCTION allocation_waitlist_append_only();--> statement-breakpoint
CREATE TRIGGER wait_ticket_sources_append_only
BEFORE UPDATE OR DELETE ON wait_ticket_sources
FOR EACH ROW EXECUTE FUNCTION allocation_waitlist_append_only();--> statement-breakpoint
-- A revoked line is never issued with an RE order afterwards, whatever code tries.
CREATE OR REPLACE FUNCTION reshare_order_sources_not_revoked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM allocation_line_dispositions x WHERE x.allocation_line_id = NEW.allocation_line_id
  ) THEN
    RAISE EXCEPTION 'allocation line % was revoked from its result and cannot be issued', NEW.allocation_line_id
      USING ERRCODE = 'IDA04';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER reshare_order_sources_not_revoked
BEFORE INSERT ON reshare_order_sources
FOR EACH ROW EXECUTE FUNCTION reshare_order_sources_not_revoked();
