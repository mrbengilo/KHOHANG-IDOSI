-- Preserve locked and disabled accounts for audit while allowing one new active
-- account to reuse their store and username. The old sessions remain revoked.
CREATE UNIQUE INDEX "users_active_email_uidx" ON "users" USING btree ("email")
  WHERE "status" = 'active' AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
DROP INDEX "users_email_uidx";--> statement-breakpoint
DROP INDEX "users_one_store_account_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_store_account_uidx" ON "users" USING btree ("store_id")
  WHERE "role" = 'store' AND "status" = 'active' AND "deleted_at" IS NULL;
