CREATE TABLE "operational_settings_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"timezone" text NOT NULL,
	"snapshot_time" time(0) without time zone NOT NULL,
	"cutoff_time" time(0) without time zone NOT NULL,
	"max_requests_per_store" integer NOT NULL,
	"policy_version" text NOT NULL,
	"idosi_sync_interval_minutes" integer NOT NULL,
	"created_by_user_id" uuid,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_settings_versions_version_positive" CHECK ("operational_settings_versions"."version" > 0),
	CONSTRAINT "operational_settings_versions_timezone_supported" CHECK ("operational_settings_versions"."timezone" = 'Asia/Ho_Chi_Minh'),
	CONSTRAINT "operational_settings_versions_cutoff_after_snapshot" CHECK ("operational_settings_versions"."cutoff_time" > "operational_settings_versions"."snapshot_time"),
	CONSTRAINT "operational_settings_versions_request_limit" CHECK ("operational_settings_versions"."max_requests_per_store" BETWEEN 1 AND 10),
	CONSTRAINT "operational_settings_versions_policy_not_blank" CHECK (length(btrim("operational_settings_versions"."policy_version")) BETWEEN 3 AND 64),
	CONSTRAINT "operational_settings_versions_sync_interval" CHECK ("operational_settings_versions"."idosi_sync_interval_minutes" IN (15, 30)),
	CONSTRAINT "operational_settings_versions_request_id_not_blank" CHECK (length(btrim("operational_settings_versions"."request_id")) BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "operational_settings_versions" ADD CONSTRAINT "operational_settings_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "operational_settings_versions_version_uidx" ON "operational_settings_versions" USING btree ("version");
--> statement-breakpoint
CREATE INDEX "operational_settings_versions_created_idx" ON "operational_settings_versions" USING btree ("created_at");
--> statement-breakpoint
INSERT INTO "operational_settings_versions" (
	"version",
	"timezone",
	"snapshot_time",
	"cutoff_time",
	"max_requests_per_store",
	"policy_version",
	"idosi_sync_interval_minutes",
	"created_by_user_id",
	"request_id"
) VALUES (
	1,
	'Asia/Ho_Chi_Minh',
	'08:00',
	'09:00',
	2,
	'ALLOC-v1.2',
	15,
	NULL,
	'migration:0003'
);
--> statement-breakpoint
CREATE TRIGGER operational_settings_versions_immutable
BEFORE UPDATE OR DELETE ON operational_settings_versions
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();
