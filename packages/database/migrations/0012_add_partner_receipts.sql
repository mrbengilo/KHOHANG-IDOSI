-- Migration: Add partner_receipts tables
-- Date: 2026-09-22
-- Description: Thêm bảng partner_receipts và partner_receipt_lines để lưu phiếu nhập hàng từ đối tác khác

-- Create enum for partner receipt status
CREATE TYPE "public"."partner_receipt_status" AS ENUM('draft', 'confirmed', 'cancelled');

-- Create partner_receipts table
CREATE TABLE IF NOT EXISTS "public"."partner_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "receipt_number" text NOT NULL UNIQUE,
  "store_id" uuid NOT NULL REFERENCES "public"."stores"("id") ON DELETE RESTRICT,
  "partner_name" text NOT NULL,
  "status" "public"."partner_receipt_status" NOT NULL DEFAULT 'draft',
  "notes" text,
  "total_quantity" integer NOT NULL DEFAULT 0,
  "version" integer NOT NULL DEFAULT 0,
  "created_by_user_id" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "confirmed_by_user_id" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone,
  
  CONSTRAINT "partner_receipts_number_not_blank" CHECK (length(btrim("receipt_number")) > 0),
  CONSTRAINT "partner_receipts_partner_name_not_blank" CHECK (length(btrim("partner_name")) >= 2),
  CONSTRAINT "partner_receipts_total_quantity_nonnegative" CHECK ("total_quantity" >= 0),
  CONSTRAINT "partner_receipts_version_nonnegative" CHECK ("version" >= 0),
  CONSTRAINT "partner_receipts_confirmed_state" CHECK (
    "status" <> 'confirmed' OR ("confirmed_by_user_id" IS NOT NULL AND "confirmed_at" IS NOT NULL)
  )
);

-- Create index for partner_receipts
CREATE INDEX "partner_receipts_store_idx" ON "public"."partner_receipts" ("store_id", "status", "created_at");

-- Create partner_receipt_lines table
CREATE TABLE IF NOT EXISTS "public"."partner_receipt_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_receipt_id" uuid NOT NULL REFERENCES "public"."partner_receipts"("id") ON DELETE RESTRICT,
  "product_id" uuid NOT NULL REFERENCES "public"."products"("id") ON DELETE RESTRICT,
  "quantity" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT "partner_receipt_lines_quantity_positive" CHECK ("quantity" > 0)
);

-- Create unique index to prevent duplicate product in same receipt
CREATE UNIQUE INDEX "partner_receipt_lines_receipt_product_uidx" 
  ON "public"."partner_receipt_lines" ("partner_receipt_id", "product_id");

-- Add comment
COMMENT ON TABLE "public"."partner_receipts" IS 'Phiếu nhập hàng từ đối tác khác (không phải từ kho tổng)';
COMMENT ON TABLE "public"."partner_receipt_lines" IS 'Chi tiết mặt hàng trong phiếu nhập từ đối tác';
