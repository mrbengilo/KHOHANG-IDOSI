ALTER TYPE "public"."store_outbound_reason" ADD VALUE IF NOT EXISTS 'sale_kg' BEFORE 'charity';--> statement-breakpoint
ALTER TYPE "public"."store_outbound_reason" ADD VALUE IF NOT EXISTS 'sale_piece' BEFORE 'charity';--> statement-breakpoint
ALTER TYPE "public"."store_outbound_reason" ADD VALUE IF NOT EXISTS 'cancel' BEFORE 'torn';
