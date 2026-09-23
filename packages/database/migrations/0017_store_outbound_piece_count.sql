ALTER TABLE "store_outbounds" ADD COLUMN "piece_count" integer;--> statement-breakpoint
ALTER TABLE "store_outbounds" ADD CONSTRAINT "store_outbounds_piece_count_matches_reason" CHECK ((("reason")::text = 'sale_piece' AND "piece_count" IS NOT NULL AND "piece_count" > 0) OR (("reason")::text <> 'sale_piece' AND "piece_count" IS NULL));
