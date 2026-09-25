ALTER TABLE sorted_sale_transfers ADD COLUMN lines jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX store_sorted_stocks_source_transfer_product_uidx ON store_sorted_stocks(source_transfer_id, product_id);
--> statement-breakpoint
DROP INDEX store_sorted_stocks_source_transfer_uidx;
--> statement-breakpoint
ALTER TABLE sorted_sale_transfers ADD CONSTRAINT sorted_sale_transfer_lines_array CHECK (lines IS NULL OR (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0));
--> statement-breakpoint
-- An older API must not settle only the first product of a new multi-line document.
CREATE FUNCTION validate_multiline_sale_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; target uuid;
BEGIN
  IF OLD.status = 'in_transit' AND NEW.status IN ('received', 'cancelled') AND NEW.lines IS NOT NULL THEN
    target := CASE WHEN NEW.status = 'received' THEN NEW.destination_store_id ELSE NEW.source_store_id END;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
      IF NOT EXISTS (SELECT 1 FROM store_sorted_stocks s WHERE s.source_transfer_id = NEW.id AND s.store_id = target AND s.product_id = (item->>'productId')::uuid AND s.sale_credited_weight_kg = (item->>'weightKg')::numeric) THEN
        RAISE EXCEPTION 'All transfer lines must be credited atomically' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sorted_sale_transfer_settlement_guard BEFORE UPDATE ON sorted_sale_transfers FOR EACH ROW EXECUTE FUNCTION validate_multiline_sale_settlement();
