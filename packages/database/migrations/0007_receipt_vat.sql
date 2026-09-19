ALTER TYPE "public"."receipt_cost_type" ADD VALUE 'vat';--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "vat_amount_vnd" bigint;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "vat_rate_percent" integer;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_vat_valid" CHECK (("receipts"."vat_amount_vnd" IS NULL AND "receipts"."vat_rate_percent" IS NULL) OR ("receipts"."vat_amount_vnd" IS NOT NULL AND "receipts"."vat_rate_percent" IS NOT NULL AND "receipts"."vat_amount_vnd" BETWEEN 0 AND 9007199254740991 AND "receipts"."vat_rate_percent" = 8));