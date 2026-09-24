CREATE TABLE "worker_heartbeats" (
	"worker" text PRIMARY KEY NOT NULL,
	"last_tick_started_at" timestamp with time zone,
	"last_tick_completed_at" timestamp with time zone,
	"last_successful_tick_at" timestamp with time zone,
	"last_error" text,
	"failing_jobs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_heartbeats_worker_not_blank" CHECK (length(btrim("worker_heartbeats"."worker")) > 0),
	CONSTRAINT "worker_heartbeats_failing_jobs_array" CHECK (jsonb_typeof("worker_heartbeats"."failing_jobs") = 'array')
);
