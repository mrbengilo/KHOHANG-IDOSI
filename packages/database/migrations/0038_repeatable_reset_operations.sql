-- Expand-only: a maintenance reset may now finish while retaining its recovery backups
-- (BACKUPS_RETAINED) instead of purging them. The new phase set is a superset of the old one,
-- so every existing journal row stays valid. This migration never resets or deletes data.
ALTER TABLE "test_data_reset_operations" DROP CONSTRAINT "test_data_reset_operations_phase_check";--> statement-breakpoint
ALTER TABLE "test_data_reset_operations" ADD CONSTRAINT "test_data_reset_operations_phase_check" CHECK ("test_data_reset_operations"."phase" IN ('DATABASE_COMMITTED','VERIFIED','BACKUPS_PURGED','BACKUPS_RETAINED','COMPLETE'));