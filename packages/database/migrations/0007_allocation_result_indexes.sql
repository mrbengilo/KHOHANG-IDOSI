CREATE INDEX "allocation_lines_product_created_id_idx" ON "allocation_lines" USING btree ("product_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "allocation_lines_status_created_id_idx" ON "allocation_lines" USING btree ("status","created_at" DESC NULLS LAST,"id");
