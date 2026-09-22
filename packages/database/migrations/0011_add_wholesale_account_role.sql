-- Migration: Add wholesale_account role to user_role enum
-- Date: 2026-09-22
-- Description: Thêm vai trò 'Cửa hàng sỉ' (wholesale_account) vào hệ thống

-- Add new value to user_role enum
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'wholesale_account';

-- Update check constraint on users table to allow wholesale_account role without store_id
-- The existing constraint already allows non-store roles to have NULL store_id, so no change needed

-- Note: wholesale_account role behaves like:
-- - storeId: NULL (not tied to any specific store)
-- - assignedStoreIds: [] (no HTKD-style assignments)
-- - Can place orders for wholesale stores
-- - Can receive goods for wholesale stores
-- - Can track order requests and allocation results
