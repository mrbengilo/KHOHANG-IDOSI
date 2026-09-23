-- Unexpected products are recorded for HTKD reconciliation. They are not added to store
-- inventory or treated as approved quantities by the receipt finalizer.
ALTER TABLE store_receipts
  ADD COLUMN unexpected_items jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE store_receipts
  ADD CONSTRAINT store_receipts_unexpected_items_array
  CHECK (jsonb_typeof(unexpected_items) = 'array');
