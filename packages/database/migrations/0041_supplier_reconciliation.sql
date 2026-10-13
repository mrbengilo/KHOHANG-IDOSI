CREATE TYPE "public"."supplier_event_coverage" AS ENUM('open', 'covered', 'ambiguous', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."supplier_event_kind" AS ENUM('order', 'order_cancel', 'source_return');--> statement-breakpoint
CREATE TYPE "public"."supplier_source_product_status" AS ENUM('pending_baseline', 'active', 'needs_reconciliation');--> statement-breakpoint
CREATE TABLE "supplier_event_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" "supplier_event_kind" NOT NULL,
	"external_ref" text NOT NULL,
	"store_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"created_by_user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_id" text,
	CONSTRAINT "supplier_event_batches_external_ref_length" CHECK (length(btrim("supplier_event_batches"."external_ref")) BETWEEN 1 AND 100),
	CONSTRAINT "supplier_event_batches_note_length" CHECK ("supplier_event_batches"."note" IS NULL OR length("supplier_event_batches"."note") <= 500),
	CONSTRAINT "supplier_event_batches_not_future" CHECK ("supplier_event_batches"."occurred_at" <= "supplier_event_batches"."recorded_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "supplier_external_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" "supplier_event_kind" NOT NULL,
	"quantity" integer NOT NULL,
	"external_ref" text NOT NULL,
	"external_line_ref" text NOT NULL,
	"store_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"coverage" "supplier_event_coverage" NOT NULL,
	"covered_by_observation_id" uuid,
	"reverses_event_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "supplier_external_events_quantity_positive" CHECK ("supplier_external_events"."quantity" > 0),
	CONSTRAINT "supplier_external_events_line_ref_length" CHECK (length(btrim("supplier_external_events"."external_line_ref")) BETWEEN 1 AND 100),
	CONSTRAINT "supplier_external_events_coverage_kind" CHECK (("supplier_external_events"."kind" = 'order_cancel') = ("supplier_external_events"."coverage" = 'not_applicable')),
	CONSTRAINT "supplier_external_events_covered_has_observation" CHECK (("supplier_external_events"."coverage" = 'covered') = ("supplier_external_events"."covered_by_observation_id" IS NOT NULL)),
	CONSTRAINT "supplier_external_events_cancel_reverses_order" CHECK (("supplier_external_events"."kind" = 'order_cancel') = ("supplier_external_events"."reverses_event_id" IS NOT NULL) OR ("supplier_external_events"."kind" = 'source_return')),
	CONSTRAINT "supplier_external_events_order_has_store" CHECK ("supplier_external_events"."kind" = 'source_return' OR "supplier_external_events"."store_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "supplier_observation_event_coverage" (
	"observation_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"included" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_observation_event_coverage_observation_id_event_id_pk" PRIMARY KEY("observation_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_order_source_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"allocation_line_id" uuid,
	"reservation_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_order_source_links_quantity_positive" CHECK ("supplier_order_source_links"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_source_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"status" "supplier_source_product_status" DEFAULT 'pending_baseline' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"baseline_observation_line_id" uuid,
	"block_reason" text,
	"blocked_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_source_products_revision_positive" CHECK ("supplier_source_products"."revision" > 0),
	CONSTRAINT "supplier_source_products_baseline_state" CHECK (("supplier_source_products"."status" = 'pending_baseline') = ("supplier_source_products"."baseline_observation_line_id" IS NULL)),
	CONSTRAINT "supplier_source_products_block_state" CHECK (("supplier_source_products"."status" = 'needs_reconciliation') = ("supplier_source_products"."block_reason" IS NOT NULL AND "supplier_source_products"."blocked_at" IS NOT NULL)),
	CONSTRAINT "supplier_source_products_block_reason_length" CHECK ("supplier_source_products"."block_reason" IS NULL OR length(btrim("supplier_source_products"."block_reason")) BETWEEN 3 AND 500)
);
--> statement-breakpoint
CREATE TABLE "supplier_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_sources_code_valid" CHECK ("supplier_sources"."code" ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
	CONSTRAINT "supplier_sources_name_length" CHECK (length(btrim("supplier_sources"."name")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "supplier_stock_observation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"observed_quantity" integer NOT NULL,
	"previous_baseline_line_id" uuid,
	"covered_event_count" integer DEFAULT 0 NOT NULL,
	"pending_delta" integer DEFAULT 0 NOT NULL,
	"effective_supplier_quantity" integer NOT NULL,
	"offer_hold_quantity" integer NOT NULL,
	"unordered_reserved_quantity" integer NOT NULL,
	"ordered_reserved_quantity" integer NOT NULL,
	"attested_unlinked_quantity" integer DEFAULT 0 NOT NULL,
	"unordered_commitment_quantity" integer NOT NULL,
	"free_quantity" integer NOT NULL,
	"shortfall_quantity" integer NOT NULL,
	"on_hand_before" integer NOT NULL,
	"reserved_before" integer NOT NULL,
	"on_hand_after" integer NOT NULL,
	"balance_version_before" integer NOT NULL,
	"ledger_entry_id" uuid,
	"status_before" "supplier_source_product_status" NOT NULL,
	"status_after" "supplier_source_product_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_stock_observation_lines_quantities_valid" CHECK ("supplier_stock_observation_lines"."observed_quantity" >= 0 AND "supplier_stock_observation_lines"."covered_event_count" >= 0 AND "supplier_stock_observation_lines"."offer_hold_quantity" >= 0 AND "supplier_stock_observation_lines"."unordered_reserved_quantity" >= 0 AND "supplier_stock_observation_lines"."ordered_reserved_quantity" >= 0 AND "supplier_stock_observation_lines"."attested_unlinked_quantity" >= 0 AND "supplier_stock_observation_lines"."free_quantity" >= 0 AND "supplier_stock_observation_lines"."shortfall_quantity" >= 0 AND "supplier_stock_observation_lines"."on_hand_before" >= 0 AND "supplier_stock_observation_lines"."reserved_before" >= 0 AND "supplier_stock_observation_lines"."balance_version_before" >= 0),
	CONSTRAINT "supplier_stock_observation_lines_formula" CHECK ("supplier_stock_observation_lines"."unordered_commitment_quantity" = "supplier_stock_observation_lines"."offer_hold_quantity" + "supplier_stock_observation_lines"."unordered_reserved_quantity" AND "supplier_stock_observation_lines"."effective_supplier_quantity" = "supplier_stock_observation_lines"."observed_quantity" + "supplier_stock_observation_lines"."pending_delta" AND "supplier_stock_observation_lines"."free_quantity" - "supplier_stock_observation_lines"."shortfall_quantity" = "supplier_stock_observation_lines"."effective_supplier_quantity" - "supplier_stock_observation_lines"."unordered_commitment_quantity" AND ("supplier_stock_observation_lines"."free_quantity" = 0 OR "supplier_stock_observation_lines"."shortfall_quantity" = 0)),
	CONSTRAINT "supplier_stock_observation_lines_projection" CHECK ("supplier_stock_observation_lines"."on_hand_after" = "supplier_stock_observation_lines"."reserved_before" + "supplier_stock_observation_lines"."free_quantity")
);
--> statement-breakpoint
CREATE TABLE "supplier_stock_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"evidence_ref" text,
	"created_by_user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_id" text,
	CONSTRAINT "supplier_stock_observations_note_length" CHECK ("supplier_stock_observations"."note" IS NULL OR length("supplier_stock_observations"."note") <= 500),
	CONSTRAINT "supplier_stock_observations_evidence_length" CHECK ("supplier_stock_observations"."evidence_ref" IS NULL OR length("supplier_stock_observations"."evidence_ref") <= 200),
	CONSTRAINT "supplier_stock_observations_not_future" CHECK ("supplier_stock_observations"."observed_at" <= "supplier_stock_observations"."recorded_at" + interval '5 minutes')
);
--> statement-breakpoint
ALTER TABLE "supplier_event_batches" ADD CONSTRAINT "supplier_event_batches_source_id_supplier_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."supplier_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_event_batches" ADD CONSTRAINT "supplier_event_batches_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_event_batches" ADD CONSTRAINT "supplier_event_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_external_events" ADD CONSTRAINT "supplier_external_events_batch_id_supplier_event_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."supplier_event_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_external_events" ADD CONSTRAINT "supplier_external_events_source_id_supplier_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."supplier_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_external_events" ADD CONSTRAINT "supplier_external_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_external_events" ADD CONSTRAINT "supplier_external_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_external_events" ADD CONSTRAINT "supplier_external_events_covered_by_observation_id_supplier_stock_observations_id_fk" FOREIGN KEY ("covered_by_observation_id") REFERENCES "public"."supplier_stock_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_external_events" ADD CONSTRAINT "supplier_external_events_reverses_event_id_supplier_external_events_id_fk" FOREIGN KEY ("reverses_event_id") REFERENCES "public"."supplier_external_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_external_events" ADD CONSTRAINT "supplier_external_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_observation_event_coverage" ADD CONSTRAINT "supplier_observation_event_coverage_observation_id_supplier_stock_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."supplier_stock_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_observation_event_coverage" ADD CONSTRAINT "supplier_observation_event_coverage_event_id_supplier_external_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."supplier_external_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_source_links" ADD CONSTRAINT "supplier_order_source_links_event_id_supplier_external_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."supplier_external_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_source_links" ADD CONSTRAINT "supplier_order_source_links_allocation_line_id_allocation_lines_id_fk" FOREIGN KEY ("allocation_line_id") REFERENCES "public"."allocation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_source_links" ADD CONSTRAINT "supplier_order_source_links_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_source_links" ADD CONSTRAINT "supplier_order_source_links_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_source_links" ADD CONSTRAINT "supplier_order_source_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_source_products" ADD CONSTRAINT "supplier_source_products_source_id_supplier_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."supplier_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_source_products" ADD CONSTRAINT "supplier_source_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_source_products" ADD CONSTRAINT "supplier_source_products_baseline_observation_line_id_supplier_stock_observation_lines_id_fk" FOREIGN KEY ("baseline_observation_line_id") REFERENCES "public"."supplier_stock_observation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_source_products" ADD CONSTRAINT "supplier_source_products_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "supplier_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_stock_observation_lines" ADD CONSTRAINT "supplier_stock_observation_lines_observation_id_supplier_stock_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."supplier_stock_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_stock_observation_lines" ADD CONSTRAINT "supplier_stock_observation_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_stock_observation_lines" ADD CONSTRAINT "supplier_stock_observation_lines_previous_baseline_line_id_supplier_stock_observation_lines_id_fk" FOREIGN KEY ("previous_baseline_line_id") REFERENCES "public"."supplier_stock_observation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_stock_observation_lines" ADD CONSTRAINT "supplier_stock_observation_lines_ledger_entry_id_warehouse_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."warehouse_ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_stock_observations" ADD CONSTRAINT "supplier_stock_observations_source_id_supplier_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."supplier_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_stock_observations" ADD CONSTRAINT "supplier_stock_observations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_event_batches_actor_key_uidx" ON "supplier_event_batches" USING btree ("created_by_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "supplier_event_batches_source_recorded_idx" ON "supplier_event_batches" USING btree ("source_id","recorded_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_event_batches_store_recorded_idx" ON "supplier_event_batches" USING btree ("store_id","recorded_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_external_events_identity_uidx" ON "supplier_external_events" USING btree ("source_id","kind","external_ref","external_line_ref");--> statement-breakpoint
CREATE INDEX "supplier_external_events_uncovered_idx" ON "supplier_external_events" USING btree ("product_id","occurred_at") WHERE "supplier_external_events"."coverage" IN ('open', 'ambiguous');--> statement-breakpoint
CREATE INDEX "supplier_external_events_product_recorded_idx" ON "supplier_external_events" USING btree ("product_id","recorded_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_external_events_batch_idx" ON "supplier_external_events" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "supplier_external_events_reverses_idx" ON "supplier_external_events" USING btree ("reverses_event_id");--> statement-breakpoint
CREATE INDEX "supplier_observation_event_coverage_event_idx" ON "supplier_observation_event_coverage" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_order_source_links_event_reservation_uidx" ON "supplier_order_source_links" USING btree ("event_id","reservation_id");--> statement-breakpoint
CREATE INDEX "supplier_order_source_links_allocation_line_idx" ON "supplier_order_source_links" USING btree ("allocation_line_id");--> statement-breakpoint
CREATE INDEX "supplier_order_source_links_reservation_idx" ON "supplier_order_source_links" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "supplier_order_source_links_store_idx" ON "supplier_order_source_links" USING btree ("store_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_source_products_product_uidx" ON "supplier_source_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "supplier_source_products_source_idx" ON "supplier_source_products" USING btree ("source_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_sources_code_uidx" ON "supplier_sources" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_stock_observation_lines_observation_product_uidx" ON "supplier_stock_observation_lines" USING btree ("observation_id","product_id");--> statement-breakpoint
CREATE INDEX "supplier_stock_observation_lines_product_idx" ON "supplier_stock_observation_lines" USING btree ("product_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_stock_observations_actor_key_uidx" ON "supplier_stock_observations" USING btree ("created_by_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "supplier_stock_observations_source_observed_idx" ON "supplier_stock_observations" USING btree ("source_id","observed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
-- Observations, their lines, coverage answers, B order links and command headers are evidence:
-- corrections are new rows (a later observation, a cancellation event), never edits or deletes.
CREATE TRIGGER supplier_stock_observations_immutable BEFORE UPDATE OR DELETE ON supplier_stock_observations
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();--> statement-breakpoint
CREATE TRIGGER supplier_stock_observation_lines_immutable BEFORE UPDATE OR DELETE ON supplier_stock_observation_lines
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();--> statement-breakpoint
CREATE TRIGGER supplier_observation_event_coverage_immutable BEFORE UPDATE OR DELETE ON supplier_observation_event_coverage
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();--> statement-breakpoint
CREATE TRIGGER supplier_order_source_links_immutable BEFORE UPDATE OR DELETE ON supplier_order_source_links
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();--> statement-breakpoint
CREATE TRIGGER supplier_event_batches_immutable BEFORE UPDATE OR DELETE ON supplier_event_batches
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();--> statement-breakpoint
CREATE TRIGGER supplier_source_products_no_delete BEFORE DELETE ON supplier_source_products
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();--> statement-breakpoint
CREATE TRIGGER supplier_sources_no_delete BEFORE DELETE ON supplier_sources
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();--> statement-breakpoint
-- A B event is a fact: only its coverage may move, and only forward (an observation covers it,
-- or a late event becomes ambiguous/open again until an observation answers).
CREATE FUNCTION supplier_external_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier_external_events rows are immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - 'coverage' - 'covered_by_observation_id')
     IS DISTINCT FROM (to_jsonb(OLD) - 'coverage' - 'covered_by_observation_id') THEN
    RAISE EXCEPTION 'only the coverage of a supplier event may change' USING ERRCODE = '55000';
  END IF;
  IF OLD.coverage = 'covered' OR OLD.coverage = 'not_applicable' THEN
    RAISE EXCEPTION 'a covered supplier event cannot change coverage' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER supplier_external_events_guard BEFORE UPDATE OR DELETE ON supplier_external_events
FOR EACH ROW EXECUTE FUNCTION supplier_external_events_guard();
