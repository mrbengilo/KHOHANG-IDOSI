-- Expand-only release, no data is changed or deleted and no reset is ever run here.
-- 1. Auditable basis for full versus partial priority offers, and the reason a wait ticket was
--    cancelled by the priority wait policy. Columns are nullable without backfill: a legacy offer
--    has no recorded basis and is never treated as a full offer, so no existing wait ticket can be
--    cancelled by this release because of history it never recorded.
-- 2. A maintenance reset may finish while retaining its recovery backups (BACKUPS_RETAINED). The
--    new phase set is a superset of the old one, so every existing journal row stays valid.
-- The previous API/worker keep working while this runs.
ALTER TABLE "test_data_reset_operations" DROP CONSTRAINT "test_data_reset_operations_phase_check";--> statement-breakpoint
ALTER TABLE "daily_priority_offers" ADD COLUMN "eligible_quantity_at_offer" integer;--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD COLUMN "cancellation_kind" text;--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD COLUMN "cancelled_by_offer_id" uuid;--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD CONSTRAINT "wait_tickets_cancelled_by_offer_id_daily_priority_offers_id_fk" FOREIGN KEY ("cancelled_by_offer_id") REFERENCES "public"."daily_priority_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_priority_offers" ADD CONSTRAINT "daily_priority_offers_eligible_covers_offer" CHECK ("daily_priority_offers"."eligible_quantity_at_offer" IS NULL OR "daily_priority_offers"."eligible_quantity_at_offer" >= "daily_priority_offers"."offered_quantity");--> statement-breakpoint
ALTER TABLE "test_data_reset_operations" ADD CONSTRAINT "test_data_reset_operations_phase_check" CHECK ("test_data_reset_operations"."phase" IN ('DATABASE_COMMITTED','VERIFIED','BACKUPS_PURGED','BACKUPS_RETAINED','COMPLETE'));--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD CONSTRAINT "wait_tickets_cancellation_kind_valid" CHECK ("wait_tickets"."cancellation_kind" IS NULL OR "wait_tickets"."cancellation_kind" IN ('store_cancelled', 'admin_cancelled', 'full_offer_declined', 'full_offer_timeout'));--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD CONSTRAINT "wait_tickets_cancellation_kind_requires_cancelled" CHECK ("wait_tickets"."cancellation_kind" IS NULL OR "wait_tickets"."status" = 'cancelled');--> statement-breakpoint
ALTER TABLE "wait_tickets" ADD CONSTRAINT "wait_tickets_offer_cancellation_has_offer" CHECK (coalesce("wait_tickets"."cancellation_kind" IN ('full_offer_declined', 'full_offer_timeout'), false) = ("wait_tickets"."cancelled_by_offer_id" IS NOT NULL));