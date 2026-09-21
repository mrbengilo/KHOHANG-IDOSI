-- Keep the stable product identity while replacing the retired display name.
-- All relational history references the product UUID, so current projections now
-- show "Quần áo nam" without rewriting immutable transaction rows.
WITH target AS (
  SELECT "id", "name", "version"
  FROM "products"
  WHERE "sku" = 'DO_NAM' AND "name" IS DISTINCT FROM 'Quần áo nam'
  FOR UPDATE
), updated AS (
  UPDATE "products" AS product
  SET "name" = 'Quần áo nam',
      "version" = product."version" + 1,
      "updated_at" = now()
  FROM target
  WHERE product."id" = target."id"
  RETURNING product."id", product."name", product."version",
    target."name" AS "previous_name", target."version" AS "previous_version"
)
INSERT INTO "audit_logs"
  ("request_id", "action", "entity_type", "entity_id", "before", "after", "metadata")
SELECT 'migration:0010', 'PRODUCT_DISPLAY_NAME_UPDATED', 'product', updated."id",
  jsonb_build_object('name', updated."previous_name", 'version', updated."previous_version"),
  jsonb_build_object('name', updated."name", 'version', updated."version"),
  '{"source":"migration","reason":"replace retired Đồ nam display name in current history and reports"}'::jsonb
FROM updated;
