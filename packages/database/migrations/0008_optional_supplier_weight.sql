ALTER TABLE "receipt_bag_weights" ALTER COLUMN "gross_weight_kg" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "receipt_bag_weights" ALTER COLUMN "net_weight_kg" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "receipt_bag_weights" ADD CONSTRAINT "receipt_bag_weights_weight_presence" CHECK (("receipt_bag_weights"."gross_weight_kg" IS NULL) = ("receipt_bag_weights"."net_weight_kg" IS NULL));
--> statement-breakpoint
CREATE SEQUENCE supplier_receipt_number_seq AS bigint MINVALUE 1;
--> statement-breakpoint
SELECT setval('supplier_receipt_number_seq', COALESCE((SELECT max(substring(receipt_number FROM '^PN([0-9]+)-')::bigint) FROM receipts WHERE receipt_number ~ '^PN[0-9]+-'), 0) + 1, false);
