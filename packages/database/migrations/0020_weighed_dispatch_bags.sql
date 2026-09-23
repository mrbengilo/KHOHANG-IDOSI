-- Sale transfers and charity exports are now entered bag by bag with each bag's weight.
-- Existing transfers keep NULL bag weights: their per-bag split was never recorded and
-- must not be guessed. Sorting no longer records bag counts on sorted stock; the old
-- bag columns stay for historical rows, so the rule tying a lot's bag count to its
-- Sale weight no longer applies (Sale can be credited to a lot without a bag count).
ALTER TABLE store_sorted_stocks DROP CONSTRAINT store_sorted_stocks_new_sale_bags_with_weight;
--> statement-breakpoint
ALTER TABLE sorted_sale_transfers ADD COLUMN bag_weights_kg numeric(14,3)[];
--> statement-breakpoint
ALTER TABLE sorted_sale_transfers ADD CONSTRAINT sorted_sale_transfers_bag_weights
  CHECK (bag_weights_kg IS NULL OR (cardinality(bag_weights_kg) = bag_quantity AND 0 < ALL (bag_weights_kg)));
--> statement-breakpoint
CREATE TABLE store_charity_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_number text NOT NULL UNIQUE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  bag_quantity integer NOT NULL CONSTRAINT store_charity_exports_bags_positive CHECK (bag_quantity > 0),
  weight_kg numeric(14,3) NOT NULL CONSTRAINT store_charity_exports_weight_positive CHECK (weight_kg > 0),
  bag_weights_kg numeric(14,3)[] NOT NULL,
  note text,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_charity_exports_bag_weights
    CHECK (cardinality(bag_weights_kg) = bag_quantity AND 0 < ALL (bag_weights_kg))
);
--> statement-breakpoint
CREATE INDEX store_charity_exports_store_created_idx ON store_charity_exports(store_id, created_at);
--> statement-breakpoint
CREATE TRIGGER store_charity_exports_sequential_code_insert BEFORE INSERT ON store_charity_exports
FOR EACH ROW EXECUTE FUNCTION assign_document_code('export_number', 'PTT');
--> statement-breakpoint
CREATE TRIGGER store_charity_exports_no_hard_delete BEFORE DELETE ON store_charity_exports
FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
--> statement-breakpoint
CREATE TRIGGER store_charity_exports_immutable BEFORE UPDATE ON store_charity_exports
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();
