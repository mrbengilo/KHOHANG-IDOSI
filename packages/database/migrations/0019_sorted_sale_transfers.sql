-- Existing Sale lots have no recorded bag count. Keep zero as "unknown" for those
-- rows; only a new sorting credit with an explicit bag count can be transferred.
ALTER TABLE store_sorted_stocks ADD COLUMN bag_quantity integer NOT NULL DEFAULT 0;
ALTER TABLE store_sorted_stocks ADD COLUMN credited_bag_quantity integer NOT NULL DEFAULT 0;
ALTER TABLE store_sorted_stocks ADD COLUMN transferred_out_bag_quantity integer NOT NULL DEFAULT 0;
ALTER TABLE store_sorted_stocks ADD COLUMN transferred_out_weight_kg numeric(14,3) NOT NULL DEFAULT 0;
ALTER TABLE store_sorted_stocks ADD COLUMN source_transfer_id uuid;
ALTER TABLE store_sorted_stocks ALTER COLUMN store_inventory_bag_id DROP NOT NULL;
ALTER TABLE store_sorting_events ALTER COLUMN store_inventory_bag_id DROP NOT NULL;
ALTER TABLE store_sorted_stocks ADD CONSTRAINT store_sorted_stocks_exactly_one_source
  CHECK ((store_inventory_bag_id IS NOT NULL)::integer + (source_transfer_id IS NOT NULL)::integer = 1);
ALTER TABLE store_sorted_stocks ADD CONSTRAINT store_sorted_stocks_bags_nonnegative
  CHECK (bag_quantity >= 0 AND credited_bag_quantity >= 0 AND transferred_out_bag_quantity >= 0);
ALTER TABLE store_sorted_stocks ADD CONSTRAINT store_sorted_stocks_bags_within_credited
  CHECK (bag_quantity + transferred_out_bag_quantity <= credited_bag_quantity);
ALTER TABLE store_sorted_stocks ADD CONSTRAINT store_sorted_stocks_new_sale_bags_with_weight
  CHECK (credited_bag_quantity = 0 OR ((bag_quantity = 0) = (sale_weight_kg = 0)));
ALTER TABLE store_sorted_stocks ADD CONSTRAINT store_sorted_stocks_weight_after_transfer
  CHECK (transferred_out_weight_kg >= 0 AND sale_weight_kg + transferred_out_weight_kg <= sale_credited_weight_kg);
CREATE UNIQUE INDEX store_sorted_stocks_source_transfer_uidx ON store_sorted_stocks(source_transfer_id);

CREATE TABLE sorted_sale_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_number text NOT NULL UNIQUE,
  source_stock_id uuid NOT NULL REFERENCES store_sorted_stocks(id) ON DELETE RESTRICT,
  destination_stock_id uuid REFERENCES store_sorted_stocks(id) ON DELETE RESTRICT,
  source_store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  destination_store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  bag_quantity integer NOT NULL CONSTRAINT sorted_sale_transfers_bags_positive CHECK (bag_quantity > 0),
  weight_kg numeric(14,3) NOT NULL CONSTRAINT sorted_sale_transfers_weight_positive CHECK (weight_kg > 0),
  entered_weight_kg numeric(14,3) CONSTRAINT sorted_sale_transfers_entered_weight_positive CHECK (entered_weight_kg IS NULL OR entered_weight_kg > 0),
  status text NOT NULL DEFAULT 'in_transit' CONSTRAINT sorted_sale_transfers_status CHECK (status IN ('in_transit', 'received')),
  note text,
  version integer NOT NULL DEFAULT 0 CONSTRAINT sorted_sale_transfers_version_nonnegative CHECK (version >= 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  received_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz,
  CONSTRAINT sorted_sale_transfers_distinct_stores CHECK (source_store_id <> destination_store_id),
  CONSTRAINT sorted_sale_transfers_receipt CHECK (status <> 'received' OR (destination_stock_id IS NOT NULL AND received_by_user_id IS NOT NULL AND received_at IS NOT NULL))
);
ALTER TABLE store_sorted_stocks ADD CONSTRAINT store_sorted_stocks_source_transfer_fk
  FOREIGN KEY (source_transfer_id) REFERENCES sorted_sale_transfers(id) ON DELETE RESTRICT;
CREATE INDEX sorted_sale_transfers_source_created_idx ON sorted_sale_transfers(source_store_id, created_at);
CREATE INDEX sorted_sale_transfers_destination_status_idx ON sorted_sale_transfers(destination_store_id, status);
CREATE TRIGGER sorted_sale_transfers_sequential_code_insert BEFORE INSERT ON sorted_sale_transfers
FOR EACH ROW EXECUTE FUNCTION assign_document_code('transfer_number', 'PDC');
CREATE TRIGGER sorted_sale_transfers_no_hard_delete BEFORE DELETE ON sorted_sale_transfers
FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();

ALTER TABLE store_sorting_events DROP CONSTRAINT store_sorting_events_action;
ALTER TABLE store_sorting_events ADD CONSTRAINT store_sorting_events_action CHECK (
  action IN ('sort_sale', 'sort_charity', 'sort_cancel', 'charity_to_sale', 'charity_export',
    'idosi_sale_kg', 'idosi_sale_piece', 'idosi_sale_correction', 'sale_transfer_out', 'sale_transfer_in')
);
CREATE TRIGGER store_sorted_stocks_no_hard_delete BEFORE DELETE ON store_sorted_stocks
FOR EACH ROW EXECUTE FUNCTION prevent_document_hard_delete();
CREATE TRIGGER store_sorting_events_immutable BEFORE UPDATE OR DELETE ON store_sorting_events
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation();
