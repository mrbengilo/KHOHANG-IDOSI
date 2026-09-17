CREATE INDEX "daily_priority_offers_wait_history_idx" ON "daily_priority_offers" USING btree ("wait_ticket_id", "created_at");
