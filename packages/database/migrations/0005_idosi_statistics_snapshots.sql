CREATE TABLE "idosi_statistics_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"period" text NOT NULL,
	"filter_date" date,
	"shift_id" text,
	"payment_method" text,
	"payload" jsonb NOT NULL,
	"source_generated_at" timestamp with time zone NOT NULL,
	"source_request_id" text NOT NULL,
	"first_synced_at" timestamp with time zone NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"synced_by_user_id" uuid,
	CONSTRAINT "idosi_statistics_snapshots_period_format" CHECK ("idosi_statistics_snapshots"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "idosi_statistics_snapshots_scope_not_blank" CHECK (length(btrim("idosi_statistics_snapshots"."scope_key")) BETWEEN 1 AND 500),
	CONSTRAINT "idosi_statistics_snapshots_shift_not_blank" CHECK ("idosi_statistics_snapshots"."shift_id" IS NULL OR length(btrim("idosi_statistics_snapshots"."shift_id")) BETWEEN 1 AND 200),
	CONSTRAINT "idosi_statistics_snapshots_payment_method" CHECK ("idosi_statistics_snapshots"."payment_method" IS NULL OR "idosi_statistics_snapshots"."payment_method" IN ('cash', 'transfer')),
	CONSTRAINT "idosi_statistics_snapshots_sync_order" CHECK ("idosi_statistics_snapshots"."last_synced_at" >= "idosi_statistics_snapshots"."first_synced_at")
);
--> statement-breakpoint
ALTER TABLE "idosi_statistics_snapshots" ADD CONSTRAINT "idosi_statistics_snapshots_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "idosi_statistics_snapshots" ADD CONSTRAINT "idosi_statistics_snapshots_synced_by_user_id_users_id_fk" FOREIGN KEY ("synced_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idosi_statistics_snapshots_store_scope_uidx" ON "idosi_statistics_snapshots" USING btree ("store_id", "scope_key");
--> statement-breakpoint
CREATE INDEX "idosi_statistics_snapshots_store_period_idx" ON "idosi_statistics_snapshots" USING btree ("store_id", "period", "last_synced_at");
--> statement-breakpoint
CREATE TABLE "idosi_statistics_sync_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"scope_key" text NOT NULL,
	"period" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"actor_user_id" uuid,
	"request_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idosi_statistics_sync_attempts_scope_not_blank" CHECK (length(btrim("idosi_statistics_sync_attempts"."scope_key")) BETWEEN 1 AND 500),
	CONSTRAINT "idosi_statistics_sync_attempts_period_format" CHECK ("idosi_statistics_sync_attempts"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "idosi_statistics_sync_attempts_source" CHECK ("idosi_statistics_sync_attempts"."source" IN ('manual', 'scheduled')),
	CONSTRAINT "idosi_statistics_sync_attempts_status" CHECK ("idosi_statistics_sync_attempts"."status" IN ('succeeded', 'failed')),
	CONSTRAINT "idosi_statistics_sync_attempts_result" CHECK (("idosi_statistics_sync_attempts"."status" = 'succeeded' AND "idosi_statistics_sync_attempts"."snapshot_id" IS NOT NULL AND "idosi_statistics_sync_attempts"."error_code" IS NULL AND "idosi_statistics_sync_attempts"."error_message" IS NULL) OR ("idosi_statistics_sync_attempts"."status" = 'failed' AND "idosi_statistics_sync_attempts"."snapshot_id" IS NULL AND "idosi_statistics_sync_attempts"."error_code" IS NOT NULL AND "idosi_statistics_sync_attempts"."error_message" IS NOT NULL)),
	CONSTRAINT "idosi_statistics_sync_attempts_time_order" CHECK ("idosi_statistics_sync_attempts"."completed_at" >= "idosi_statistics_sync_attempts"."started_at"),
	CONSTRAINT "idosi_statistics_sync_attempts_request_id_not_blank" CHECK (length(btrim("idosi_statistics_sync_attempts"."request_id")) BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "idosi_statistics_sync_attempts" ADD CONSTRAINT "idosi_statistics_sync_attempts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "idosi_statistics_sync_attempts" ADD CONSTRAINT "idosi_statistics_sync_attempts_snapshot_id_idosi_statistics_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."idosi_statistics_snapshots"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "idosi_statistics_sync_attempts" ADD CONSTRAINT "idosi_statistics_sync_attempts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idosi_statistics_sync_attempts_scope_completed_idx" ON "idosi_statistics_sync_attempts" USING btree ("store_id", "scope_key", "completed_at");
--> statement-breakpoint
CREATE INDEX "idosi_statistics_sync_attempts_scheduler_idx" ON "idosi_statistics_sync_attempts" USING btree ("period", "source", "completed_at");
--> statement-breakpoint
CREATE TRIGGER idosi_statistics_sync_attempts_immutable
BEFORE UPDATE OR DELETE ON idosi_statistics_sync_attempts
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();
