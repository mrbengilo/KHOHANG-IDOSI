-- Keep the original bag_code for provenance and immutable audit history. Assign a
-- short, permanent display code independently within each store.
ALTER TABLE "store_inventory_bags" ADD COLUMN "display_code" text;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY store_id ORDER BY created_at, id) AS number
  FROM store_inventory_bags
)
UPDATE store_inventory_bags AS bag
SET display_code = 'MB-' || lpad(numbered.number::text, greatest(5, length(numbered.number::text)), '0')
FROM numbered
WHERE bag.id = numbered.id;

CREATE TABLE "store_inventory_bag_code_counters" (
  "store_id" uuid PRIMARY KEY REFERENCES "stores"("id") ON DELETE restrict,
  "last_number" bigint NOT NULL CHECK ("last_number" >= 0)
);

INSERT INTO store_inventory_bag_code_counters (store_id, last_number)
SELECT store_id, count(*)::bigint
FROM store_inventory_bags
GROUP BY store_id;

CREATE FUNCTION assign_store_inventory_bag_display_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_number bigint;
BEGIN
  INSERT INTO store_inventory_bag_code_counters (store_id, last_number)
  VALUES (NEW.store_id, 1)
  ON CONFLICT (store_id) DO UPDATE
    SET last_number = store_inventory_bag_code_counters.last_number + 1
  RETURNING last_number INTO next_number;

  NEW.display_code := 'MB-' || lpad(next_number::text, greatest(5, length(next_number::text)), '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER store_inventory_bag_display_code_insert
BEFORE INSERT ON store_inventory_bags
FOR EACH ROW EXECUTE FUNCTION assign_store_inventory_bag_display_code();

ALTER TABLE "store_inventory_bags" ALTER COLUMN "display_code" SET DEFAULT '';
ALTER TABLE "store_inventory_bags" ALTER COLUMN "display_code" SET NOT NULL;
ALTER TABLE "store_inventory_bags" ADD CONSTRAINT "store_inventory_bags_display_code_format"
  CHECK ("display_code" ~ '^MB-[0-9]{5,}$');
CREATE UNIQUE INDEX "store_inventory_bags_store_display_code_uidx"
  ON "store_inventory_bags" ("store_id", "display_code");
