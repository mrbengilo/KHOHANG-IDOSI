-- Expand-only release. Stock, reservations, shipments and receipts are not changed here.
-- 1. allocation_result_decisions: a store's answer (accept/reject) to one published allocation
--    result (run x store), stored apart from the algorithm and shipping statuses.
-- 2. Every result published before this release is classified LEGACY (origin legacy_backfill):
--    it keeps the old shipping rules and is never shown as an answer the store gave. The rows are
--    the durable cutover boundary: from now on a result without a decision row is an integrity
--    error and its goods never ship.
-- 3. Database guards that hold whatever code runs (the previous worker during deploy, a rollback,
--    a backfill): an allocation shipment cannot become dispatched unless its result and every
--    reserved source on it are accepted, not_required or legacy, and a run cannot complete
--    without a decision row for every store it allocated to.
CREATE TYPE "public"."allocation_decision_status" AS ENUM('pending', 'accepted', 'rejected', 'not_required', 'legacy');--> statement-breakpoint
CREATE TABLE "allocation_result_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_run_id" uuid NOT NULL,
	"order_session_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "allocation_decision_status" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"granted_quantity" integer DEFAULT 0 NOT NULL,
	"origin" text DEFAULT 'allocation_run' NOT NULL,
	"responded_at" timestamp with time zone,
	"responded_by_user_id" uuid,
	"response_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_result_decisions_version_positive" CHECK ("allocation_result_decisions"."version" > 0),
	CONSTRAINT "allocation_result_decisions_granted_nonnegative" CHECK ("allocation_result_decisions"."granted_quantity" >= 0),
	CONSTRAINT "allocation_result_decisions_origin_valid" CHECK ("allocation_result_decisions"."origin" IN ('allocation_run', 'legacy_backfill')),
	CONSTRAINT "allocation_result_decisions_legacy_origin" CHECK (("allocation_result_decisions"."status" = 'legacy') = ("allocation_result_decisions"."origin" = 'legacy_backfill')),
	CONSTRAINT "allocation_result_decisions_pending_has_goods" CHECK ("allocation_result_decisions"."status" NOT IN ('pending', 'accepted', 'rejected') OR "allocation_result_decisions"."granted_quantity" > 0),
	CONSTRAINT "allocation_result_decisions_not_required_has_no_goods" CHECK ("allocation_result_decisions"."status" <> 'not_required' OR "allocation_result_decisions"."granted_quantity" = 0),
	CONSTRAINT "allocation_result_decisions_answer_recorded" CHECK (("allocation_result_decisions"."status" IN ('accepted', 'rejected')) = ("allocation_result_decisions"."responded_at" IS NOT NULL AND "allocation_result_decisions"."responded_by_user_id" IS NOT NULL)),
	CONSTRAINT "allocation_result_decisions_reason_only_rejected" CHECK ("allocation_result_decisions"."response_reason" IS NULL OR ("allocation_result_decisions"."status" = 'rejected' AND length(btrim("allocation_result_decisions"."response_reason")) BETWEEN 1 AND 500))
);
--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" ADD CONSTRAINT "allocation_result_decisions_allocation_run_id_allocation_runs_id_fk" FOREIGN KEY ("allocation_run_id") REFERENCES "public"."allocation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" ADD CONSTRAINT "allocation_result_decisions_order_session_id_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."order_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" ADD CONSTRAINT "allocation_result_decisions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_result_decisions" ADD CONSTRAINT "allocation_result_decisions_responded_by_user_id_users_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_result_decisions_run_store_uidx" ON "allocation_result_decisions" USING btree ("allocation_run_id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_result_decisions_one_pending_uidx" ON "allocation_result_decisions" USING btree ("order_session_id","store_id") WHERE "allocation_result_decisions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "allocation_result_decisions_store_status_idx" ON "allocation_result_decisions" USING btree ("store_id","status","created_at");--> statement-breakpoint
CREATE INDEX "allocation_result_decisions_status_created_idx" ON "allocation_result_decisions" USING btree ("status","created_at");--> statement-breakpoint
INSERT INTO "allocation_result_decisions" ("allocation_run_id", "order_session_id", "store_id", "status", "version", "granted_quantity", "origin", "created_at", "updated_at")
SELECT "r"."id", "r"."order_session_id", "l"."store_id", 'legacy', 1, sum("l"."allocated_quantity"), 'legacy_backfill', now(), now()
FROM "allocation_runs" "r"
JOIN "allocation_lines" "l" ON "l"."allocation_run_id" = "r"."id"
GROUP BY "r"."id", "r"."order_session_id", "l"."store_id"
ON CONFLICT ("allocation_run_id", "store_id") DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION allocation_shipment_dispatch_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM allocation_result_decisions d
    WHERE d.allocation_run_id = NEW.allocation_run_id
      AND d.store_id = NEW.store_id
      AND d.status IN ('accepted', 'not_required', 'legacy')
  ) THEN
    RAISE EXCEPTION 'ALLOCATION_DECISION_REQUIRED: shipment % needs an accepted allocation result before dispatch', NEW.id
      USING ERRCODE = 'IDA01';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM outbound_request_lines ol
    JOIN reservations r ON r.outbound_request_line_id = ol.id
    LEFT JOIN allocation_lines al ON al.id = r.allocation_line_id
    WHERE ol.outbound_request_id = NEW.id
      AND r.status = 'active'
      AND r.deleted_at IS NULL
      AND (
        al.id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM allocation_result_decisions d
          WHERE d.allocation_run_id = al.allocation_run_id
            AND d.store_id = al.store_id
            AND d.status IN ('accepted', 'not_required', 'legacy')
        )
      )
  ) THEN
    RAISE EXCEPTION 'ALLOCATION_DECISION_REQUIRED: shipment % carries goods of an unanswered or rejected allocation result', NEW.id
      USING ERRCODE = 'IDA01';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER outbound_requests_allocation_dispatch_guard
BEFORE UPDATE OF status ON outbound_requests
FOR EACH ROW
WHEN (NEW.status = 'dispatched' AND OLD.status IS DISTINCT FROM 'dispatched' AND NEW.allocation_run_id IS NOT NULL)
EXECUTE FUNCTION allocation_shipment_dispatch_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION allocation_run_completion_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM allocation_lines l
    WHERE l.allocation_run_id = NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM allocation_result_decisions d
        WHERE d.allocation_run_id = l.allocation_run_id AND d.store_id = l.store_id
      )
  ) THEN
    RAISE EXCEPTION 'ALLOCATION_DECISION_MISSING: allocation run % cannot complete without a decision for every store', NEW.id
      USING ERRCODE = 'IDA02';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER allocation_runs_completion_guard
BEFORE UPDATE OF status ON allocation_runs
FOR EACH ROW
WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
EXECUTE FUNCTION allocation_run_completion_guard();--> statement-breakpoint
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
  IF OLD.status <> 'pending' AND (
    NEW.status <> OLD.status OR NEW.version <> OLD.version
    OR NEW.responded_at IS DISTINCT FROM OLD.responded_at
    OR NEW.responded_by_user_id IS DISTINCT FROM OLD.responded_by_user_id
    OR NEW.response_reason IS DISTINCT FROM OLD.response_reason
  ) THEN
    RAISE EXCEPTION 'allocation result decision % is final', OLD.id USING ERRCODE = 'IDA03';
  END IF;
  IF OLD.status = 'pending' AND NEW.status <> 'pending' AND (
    NEW.status NOT IN ('accepted', 'rejected') OR NEW.version <> OLD.version + 1
  ) THEN
    RAISE EXCEPTION 'pending allocation result decision % can only be accepted or rejected once', OLD.id
      USING ERRCODE = 'IDA03';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER allocation_result_decisions_protect_history
BEFORE UPDATE OR DELETE ON allocation_result_decisions
FOR EACH ROW EXECUTE FUNCTION allocation_result_decisions_protect_history();
