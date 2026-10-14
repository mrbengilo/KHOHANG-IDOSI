-- Expand-only release (docs/store-active-wait-document.md).
-- A store-level wait document "phiếu chờ" (code PCT-xxxxxx) over the per-product wait tickets:
-- at most one current document per store (unique partial index), immutable once closed, chained
-- predecessor -> successor with per-product carry-over checked at commit. Wait tickets, offers,
-- allocation lines, reservations, results and RE orders are not modified. Existing open demand is
-- backfilled into one current document per store (event migration_backfill); nothing is invented:
-- every bag comes from an active ticket's remaining quantity or a hold of a PENDING result.
CREATE TABLE "store_wait_document_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_key" text,
	"actor_user_id" uuid,
	"actor_role" text,
	"actor_display_name" text,
	"request_id" text,
	"order_session_id" uuid,
	"allocation_run_id" uuid,
	"allocation_decision_id" uuid,
	"wait_ticket_id" uuid,
	"priority_offer_id" uuid,
	"store_receipt_id" uuid,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_wait_document_events_kind_valid" CHECK ("store_wait_document_events"."kind" IN ('allocation_run', 'result_accepted', 'result_waitlisted', 'wait_ticket_cancelled', 'wait_document_cancelled', 'priority_offer_response', 'receipt_shortage', 'receipt_adjustment', 'system_sync', 'migration_backfill')),
	CONSTRAINT "store_wait_document_events_actor_role_valid" CHECK ("store_wait_document_events"."actor_role" IS NULL OR "store_wait_document_events"."actor_role" IN ('admin', 'htkd', 'store', 'wholesale'))
);
--> statement-breakpoint
CREATE TABLE "store_wait_document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"carried_in_quantity" integer NOT NULL,
	"added_quantity" integer NOT NULL,
	"opening_remaining_quantity" integer NOT NULL,
	"opening_pending_quantity" integer NOT NULL,
	"confirmed_quantity" integer,
	"cancelled_quantity" integer,
	"adjusted_quantity" integer,
	"carried_out_quantity" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_wait_document_lines_opening_valid" CHECK ("store_wait_document_lines"."carried_in_quantity" >= 0 AND "store_wait_document_lines"."added_quantity" >= 0 AND "store_wait_document_lines"."opening_remaining_quantity" >= 0 AND "store_wait_document_lines"."opening_pending_quantity" >= 0 AND "store_wait_document_lines"."carried_in_quantity" + "store_wait_document_lines"."added_quantity" > 0 AND "store_wait_document_lines"."carried_in_quantity" + "store_wait_document_lines"."added_quantity" = "store_wait_document_lines"."opening_remaining_quantity" + "store_wait_document_lines"."opening_pending_quantity"),
	CONSTRAINT "store_wait_document_lines_closing_valid" CHECK (("store_wait_document_lines"."confirmed_quantity" IS NULL AND "store_wait_document_lines"."cancelled_quantity" IS NULL AND "store_wait_document_lines"."adjusted_quantity" IS NULL AND "store_wait_document_lines"."carried_out_quantity" IS NULL) OR ("store_wait_document_lines"."confirmed_quantity" >= 0 AND "store_wait_document_lines"."cancelled_quantity" >= 0 AND "store_wait_document_lines"."adjusted_quantity" >= 0 AND "store_wait_document_lines"."carried_out_quantity" >= 0 AND "store_wait_document_lines"."confirmed_quantity" + "store_wait_document_lines"."cancelled_quantity" + "store_wait_document_lines"."adjusted_quantity" + "store_wait_document_lines"."carried_out_quantity" = "store_wait_document_lines"."carried_in_quantity" + "store_wait_document_lines"."added_quantity"))
);
--> statement-breakpoint
CREATE TABLE "store_wait_document_members" (
	"document_id" uuid NOT NULL,
	"wait_ticket_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_wait_document_members_document_id_wait_ticket_id_pk" PRIMARY KEY("document_id","wait_ticket_id")
);
--> statement-breakpoint
CREATE TABLE "store_wait_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"store_id" uuid NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"chain_id" uuid NOT NULL,
	"chain_sequence" integer NOT NULL,
	"predecessor_id" uuid,
	"opened_event_id" uuid NOT NULL,
	"closed_event_id" uuid,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"waiting_since" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_wait_documents_status_valid" CHECK ("store_wait_documents"."status" IN ('current', 'merged', 'rolled_over', 'completed', 'cancelled')),
	CONSTRAINT "store_wait_documents_code_format" CHECK ("store_wait_documents"."code" ~ '^PCT-[0-9]{6}$'),
	CONSTRAINT "store_wait_documents_closed_state" CHECK (("store_wait_documents"."status" = 'current') = ("store_wait_documents"."closed_at" IS NULL AND "store_wait_documents"."closed_event_id" IS NULL)),
	CONSTRAINT "store_wait_documents_version_state" CHECK (("store_wait_documents"."status" = 'current' AND "store_wait_documents"."version" = 1) OR ("store_wait_documents"."status" <> 'current' AND "store_wait_documents"."version" = 2)),
	CONSTRAINT "store_wait_documents_chain_start" CHECK (("store_wait_documents"."predecessor_id" IS NULL) = ("store_wait_documents"."chain_sequence" = 1 AND "store_wait_documents"."chain_id" = "store_wait_documents"."id")),
	CONSTRAINT "store_wait_documents_not_own_predecessor" CHECK ("store_wait_documents"."predecessor_id" <> "store_wait_documents"."id")
);
--> statement-breakpoint
ALTER TABLE "store_wait_document_events" ADD CONSTRAINT "store_wait_document_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_events" ADD CONSTRAINT "store_wait_document_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_events" ADD CONSTRAINT "store_wait_document_events_order_session_id_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."order_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_events" ADD CONSTRAINT "store_wait_document_events_allocation_run_id_allocation_runs_id_fk" FOREIGN KEY ("allocation_run_id") REFERENCES "public"."allocation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_events" ADD CONSTRAINT "store_wait_document_events_allocation_decision_id_allocation_result_decisions_id_fk" FOREIGN KEY ("allocation_decision_id") REFERENCES "public"."allocation_result_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_events" ADD CONSTRAINT "store_wait_document_events_wait_ticket_id_wait_tickets_id_fk" FOREIGN KEY ("wait_ticket_id") REFERENCES "public"."wait_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_events" ADD CONSTRAINT "store_wait_document_events_priority_offer_id_daily_priority_offers_id_fk" FOREIGN KEY ("priority_offer_id") REFERENCES "public"."daily_priority_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_events" ADD CONSTRAINT "store_wait_document_events_store_receipt_id_store_receipts_id_fk" FOREIGN KEY ("store_receipt_id") REFERENCES "public"."store_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_lines" ADD CONSTRAINT "store_wait_document_lines_document_id_store_wait_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."store_wait_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_lines" ADD CONSTRAINT "store_wait_document_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_lines" ADD CONSTRAINT "store_wait_document_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_document_members" ADD CONSTRAINT "store_wait_document_members_document_id_store_wait_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."store_wait_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_documents" ADD CONSTRAINT "store_wait_documents_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_documents" ADD CONSTRAINT "store_wait_documents_predecessor_id_store_wait_documents_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."store_wait_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_documents" ADD CONSTRAINT "store_wait_documents_opened_event_id_store_wait_document_events_id_fk" FOREIGN KEY ("opened_event_id") REFERENCES "public"."store_wait_document_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_wait_documents" ADD CONSTRAINT "store_wait_documents_closed_event_id_store_wait_document_events_id_fk" FOREIGN KEY ("closed_event_id") REFERENCES "public"."store_wait_document_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_wait_document_events_source_uidx" ON "store_wait_document_events" USING btree ("store_id","source_key") WHERE "store_wait_document_events"."source_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "store_wait_document_events_store_idx" ON "store_wait_document_events" USING btree ("store_id","occurred_at");--> statement-breakpoint
CREATE INDEX "store_wait_document_events_decision_idx" ON "store_wait_document_events" USING btree ("allocation_decision_id") WHERE "store_wait_document_events"."allocation_decision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "store_wait_document_lines_product_uidx" ON "store_wait_document_lines" USING btree ("document_id","product_id");--> statement-breakpoint
CREATE INDEX "store_wait_document_lines_product_idx" ON "store_wait_document_lines" USING btree ("product_id","document_id");--> statement-breakpoint
CREATE INDEX "store_wait_document_members_ticket_idx" ON "store_wait_document_members" USING btree ("wait_ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_wait_documents_code_uidx" ON "store_wait_documents" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "store_wait_documents_one_current_uidx" ON "store_wait_documents" USING btree ("store_id") WHERE "store_wait_documents"."status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "store_wait_documents_predecessor_uidx" ON "store_wait_documents" USING btree ("predecessor_id") WHERE "store_wait_documents"."predecessor_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "store_wait_documents_chain_sequence_uidx" ON "store_wait_documents" USING btree ("chain_id","chain_sequence");--> statement-breakpoint
CREATE INDEX "store_wait_documents_store_opened_idx" ON "store_wait_documents" USING btree ("store_id","opened_at","id");--> statement-breakpoint
CREATE INDEX "store_wait_documents_opened_page_idx" ON "store_wait_documents" USING btree ("opened_at","id");--> statement-breakpoint
CREATE TRIGGER store_wait_documents_sequential_code_insert BEFORE INSERT ON store_wait_documents
FOR EACH ROW EXECUTE FUNCTION assign_document_code('code', 'PCT');--> statement-breakpoint
-- Insert opens a current document (a chain start, or the successor of a document closed in the
-- same event); update only closes a current document once. Nothing is ever deleted.
CREATE OR REPLACE FUNCTION store_wait_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE previous store_wait_documents%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'store wait documents are never deleted' USING ERRCODE = 'IDA03';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'current' THEN
      RAISE EXCEPTION 'a store wait document is opened as current' USING ERRCODE = 'IDA03';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM store_wait_document_events e
      WHERE e.id = NEW.opened_event_id AND e.store_id = NEW.store_id
    ) THEN
      RAISE EXCEPTION 'store wait document % names an event of another store', NEW.id
        USING ERRCODE = 'IDA04';
    END IF;
    IF NEW.predecessor_id IS NOT NULL THEN
      SELECT * INTO previous FROM store_wait_documents WHERE id = NEW.predecessor_id;
      IF NOT FOUND OR previous.store_id <> NEW.store_id OR previous.chain_id <> NEW.chain_id
        OR NEW.chain_sequence <> previous.chain_sequence + 1
        OR previous.status NOT IN ('merged', 'rolled_over')
        OR previous.closed_event_id IS DISTINCT FROM NEW.opened_event_id THEN
        RAISE EXCEPTION 'store wait document % does not continue its predecessor', NEW.id
          USING ERRCODE = 'IDA04';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'current' OR NEW.status = 'current' OR NEW.version <> OLD.version + 1
    OR NEW.id <> OLD.id OR NEW.code <> OLD.code OR NEW.store_id <> OLD.store_id
    OR NEW.chain_id <> OLD.chain_id OR NEW.chain_sequence <> OLD.chain_sequence
    OR NEW.predecessor_id IS DISTINCT FROM OLD.predecessor_id
    OR NEW.opened_event_id <> OLD.opened_event_id OR NEW.opened_at <> OLD.opened_at
    OR NEW.waiting_since <> OLD.waiting_since OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'store wait document % is closed once and never edited', OLD.id
      USING ERRCODE = 'IDA03';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM store_wait_document_events e
    WHERE e.id = NEW.closed_event_id AND e.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'store wait document % names a closing event of another store', OLD.id
      USING ERRCODE = 'IDA04';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_wait_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON store_wait_documents
FOR EACH ROW EXECUTE FUNCTION store_wait_documents_guard();--> statement-breakpoint
-- Opening columns are written with the line; closing columns once, when the document closes.
CREATE OR REPLACE FUNCTION store_wait_document_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'store wait document lines are never deleted' USING ERRCODE = 'IDA03';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.confirmed_quantity IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM store_wait_documents d
      WHERE d.id = NEW.document_id AND d.store_id = NEW.store_id AND d.status = 'current'
    ) THEN
      RAISE EXCEPTION 'a line is added to a current document of its own store, unclosed'
        USING ERRCODE = 'IDA04';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.confirmed_quantity IS NOT NULL OR NEW.id <> OLD.id OR NEW.document_id <> OLD.document_id
    OR NEW.store_id <> OLD.store_id OR NEW.product_id <> OLD.product_id
    OR NEW.carried_in_quantity <> OLD.carried_in_quantity
    OR NEW.added_quantity <> OLD.added_quantity
    OR NEW.opening_remaining_quantity <> OLD.opening_remaining_quantity
    OR NEW.opening_pending_quantity <> OLD.opening_pending_quantity
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'store wait document line % is closed once and never edited', OLD.id
      USING ERRCODE = 'IDA03';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_wait_document_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON store_wait_document_lines
FOR EACH ROW EXECUTE FUNCTION store_wait_document_lines_guard();--> statement-breakpoint
-- Checked at commit, for the document and for the hand-over from its predecessor: a current
-- document has open lines only; a closed one has every line closed; what a merged or rolled-over
-- document carried out is exactly what its successor carried in, product by product; a completed
-- or cancelled document carried nothing out and has no successor.
CREATE OR REPLACE FUNCTION store_wait_documents_check(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE doc store_wait_documents%ROWTYPE;
DECLARE successor_id uuid;
BEGIN
  SELECT * INTO doc FROM store_wait_documents WHERE id = target;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM store_wait_document_lines l WHERE l.document_id = doc.id) THEN
    RAISE EXCEPTION 'store wait document % has no line', doc.id USING ERRCODE = 'IDA04';
  END IF;
  IF EXISTS (
    SELECT 1 FROM store_wait_document_lines l
    WHERE l.document_id = doc.id AND (l.confirmed_quantity IS NULL) <> (doc.status = 'current')
  ) THEN
    RAISE EXCEPTION 'lines of store wait document % do not match its status', doc.id
      USING ERRCODE = 'IDA04';
  END IF;
  SELECT s.id INTO successor_id FROM store_wait_documents s WHERE s.predecessor_id = doc.id;
  IF doc.status IN ('merged', 'rolled_over') THEN
    IF successor_id IS NULL THEN
      RAISE EXCEPTION 'store wait document % was handed over without a successor', doc.id
        USING ERRCODE = 'IDA04';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM (SELECT product_id, carried_out_quantity AS q FROM store_wait_document_lines
            WHERE document_id = doc.id AND carried_out_quantity > 0) o
      FULL JOIN (SELECT product_id, carried_in_quantity AS q FROM store_wait_document_lines
                 WHERE document_id = successor_id AND carried_in_quantity > 0) i
        ON i.product_id = o.product_id
      WHERE o.q IS DISTINCT FROM i.q
    ) THEN
      RAISE EXCEPTION 'store wait document % hands over other bags than its successor received', doc.id
        USING ERRCODE = 'IDA04';
    END IF;
  ELSIF doc.status IN ('completed', 'cancelled') THEN
    IF successor_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM store_wait_document_lines l
      WHERE l.document_id = doc.id AND l.carried_out_quantity > 0
    ) THEN
      RAISE EXCEPTION 'closed store wait document % still hands bags over', doc.id
        USING ERRCODE = 'IDA04';
    END IF;
  ELSIF successor_id IS NOT NULL THEN
    RAISE EXCEPTION 'current store wait document % already has a successor', doc.id
      USING ERRCODE = 'IDA04';
  END IF;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION store_wait_documents_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target uuid;
DECLARE previous uuid;
BEGIN
  IF TG_TABLE_NAME = 'store_wait_document_lines' THEN
    target := NEW.document_id;
  ELSE
    target := NEW.id;
  END IF;
  PERFORM store_wait_documents_check(target);
  SELECT predecessor_id INTO previous FROM store_wait_documents WHERE id = target;
  IF previous IS NOT NULL THEN
    PERFORM store_wait_documents_check(previous);
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER store_wait_documents_consistency
AFTER INSERT OR UPDATE ON store_wait_documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION store_wait_documents_consistency();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER store_wait_document_lines_consistency
AFTER INSERT OR UPDATE ON store_wait_document_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION store_wait_documents_consistency();--> statement-breakpoint
-- A member is a ticket of the same store and product, added while the document is current.
CREATE OR REPLACE FUNCTION store_wait_document_members_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM wait_tickets w
    WHERE w.id = NEW.wait_ticket_id AND w.store_id = NEW.store_id AND w.product_id = NEW.product_id
  ) OR NOT EXISTS (
    SELECT 1 FROM store_wait_documents d
    WHERE d.id = NEW.document_id AND d.store_id = NEW.store_id AND d.status = 'current'
  ) THEN
    RAISE EXCEPTION 'wait ticket % is not a ticket of the current document''s store', NEW.wait_ticket_id
      USING ERRCODE = 'IDA04';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_wait_document_members_guard BEFORE INSERT ON store_wait_document_members
FOR EACH ROW EXECUTE FUNCTION store_wait_document_members_guard();--> statement-breakpoint
CREATE TRIGGER store_wait_document_members_append_only
BEFORE UPDATE OR DELETE ON store_wait_document_members
FOR EACH ROW EXECUTE FUNCTION allocation_waitlist_append_only();--> statement-breakpoint
CREATE TRIGGER store_wait_document_events_append_only
BEFORE UPDATE OR DELETE ON store_wait_document_events
FOR EACH ROW EXECUTE FUNCTION allocation_waitlist_append_only();--> statement-breakpoint
-- Backfill: the open demand of each store (active tickets' remaining quantity and holds of
-- PENDING results granted from tickets) becomes one current document, codes in store code order.
CREATE TEMP TABLE store_wait_backfill_lines ON COMMIT DROP AS
SELECT live.store_id, live.product_id,
  sum(live.remaining)::integer AS remaining, sum(live.pending)::integer AS pending,
  min(live.queued_at) AS waiting_since, array_agg(DISTINCT live.wait_ticket_id) AS tickets
FROM (
  SELECT w.store_id, w.product_id, w.id AS wait_ticket_id, w.remaining_quantity AS remaining,
    0 AS pending, w.queued_at
  FROM wait_tickets w
  WHERE w.status = 'active' AND w.deleted_at IS NULL AND w.remaining_quantity > 0
  UNION ALL
  SELECT al.store_id, al.product_id, al.wait_ticket_id, 0, r.quantity, w.queued_at
  FROM allocation_result_decisions d
  JOIN allocation_lines al ON al.allocation_run_id = d.allocation_run_id
    AND al.store_id = d.store_id AND al.wait_ticket_id IS NOT NULL
  JOIN reservations r ON r.allocation_line_id = al.id AND r.status = 'active' AND r.deleted_at IS NULL
  JOIN wait_tickets w ON w.id = al.wait_ticket_id
  WHERE d.status = 'pending'
) live
GROUP BY live.store_id, live.product_id;--> statement-breakpoint
CREATE TEMP TABLE store_wait_backfill_documents ON COMMIT DROP AS
SELECT b.store_id, gen_random_uuid() AS document_id, gen_random_uuid() AS event_id,
  min(b.waiting_since) AS waiting_since, min(s.code) AS store_code
FROM store_wait_backfill_lines b
JOIN stores s ON s.id = b.store_id
WHERE NOT EXISTS (
  SELECT 1 FROM store_wait_documents d WHERE d.store_id = b.store_id AND d.status = 'current'
)
GROUP BY b.store_id;--> statement-breakpoint
INSERT INTO store_wait_document_events (id, store_id, kind, source_key, metadata, occurred_at)
SELECT event_id, store_id, 'migration_backfill', 'migration:0045',
  jsonb_build_object('migration', '0045_store_wait_documents'), now()
FROM store_wait_backfill_documents;--> statement-breakpoint
INSERT INTO store_wait_documents (
  id, store_id, status, version, chain_id, chain_sequence, opened_event_id, opened_at, waiting_since
)
SELECT document_id, store_id, 'current', 1, document_id, 1, event_id, now(), waiting_since
FROM store_wait_backfill_documents
ORDER BY store_code, store_id;--> statement-breakpoint
INSERT INTO store_wait_document_lines (
  document_id, store_id, product_id, carried_in_quantity, added_quantity,
  opening_remaining_quantity, opening_pending_quantity
)
SELECT d.document_id, b.store_id, b.product_id, 0, b.remaining + b.pending, b.remaining, b.pending
FROM store_wait_backfill_lines b
JOIN store_wait_backfill_documents d ON d.store_id = b.store_id
WHERE b.remaining + b.pending > 0;--> statement-breakpoint
INSERT INTO store_wait_document_members (document_id, wait_ticket_id, store_id, product_id)
SELECT DISTINCT d.document_id, ticket.id, b.store_id, b.product_id
FROM store_wait_backfill_lines b
JOIN store_wait_backfill_documents d ON d.store_id = b.store_id
CROSS JOIN LATERAL unnest(b.tickets) AS ticket(id);
