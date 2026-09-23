-- The "Cửa hàng sỉ" desk is one account covering every wholesale store, so it needs a
-- role of its own rather than a store account pinned to a single wholesale store.
-- The value is added on its own: PostgreSQL refuses to use a new enum label inside the
-- same transaction that created it, so nothing here may reference 'wholesale' yet.
-- The existing users_store_scope_matches_role check already forces store_id to stay NULL
-- for every non-store role, which is exactly what this desk needs.
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'wholesale';
