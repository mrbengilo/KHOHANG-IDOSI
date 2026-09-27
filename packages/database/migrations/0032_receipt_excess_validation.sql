-- Align legacy guards with the existing declared-excess booking commands.
-- No historical documents or inventory are rewritten. All receipt/ledger checks remain.
CREATE OR REPLACE FUNCTION validate_store_receipt_line_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Excess-only SKUs have no dispatched line. They must match the store declaration.
  IF NEW.outbound_request_line_id IS NULL THEN
    IF NEW.approved_quantity <> 0 OR NEW.received_quantity <> 0 OR NEW.excess_quantity <= 0
      OR NOT EXISTS (
        SELECT 1 FROM store_receipts sr,
          jsonb_array_elements(sr.unexpected_items) item
        WHERE sr.id = NEW.store_receipt_id
          AND item->>'productId' = NEW.product_id::text
          AND (item->>'quantity')::integer = NEW.excess_quantity
      ) THEN
      RAISE EXCEPTION 'unexpected receipt line must match the declared excess goods' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM store_receipts sr
    JOIN outbound_request_lines ol ON ol.outbound_request_id = sr.outbound_request_id
    WHERE sr.id = NEW.store_receipt_id
      AND ol.id = NEW.outbound_request_line_id
      AND ol.product_id = NEW.product_id
      AND ol.approved_quantity = NEW.approved_quantity
      AND ol.dispatched_quantity = NEW.approved_quantity
  ) THEN
    RAISE EXCEPTION 'store receipt line does not match its dispatched outbound line'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_store_receipt_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'finalized' THEN
    RAISE EXCEPTION 'a finalized store receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'finalized' AND OLD.status <> 'finalized' THEN
    IF NOT EXISTS (
      SELECT 1 FROM store_receipt_lines l WHERE l.store_receipt_id = NEW.id
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id
        AND (
          ((l.received_quantity + l.excess_quantity) > 0 AND l.price_per_kg_vnd IS NULL)
          OR (SELECT count(*) FROM store_receipt_bags b WHERE b.store_receipt_line_id = l.id) <> l.received_quantity + l.excess_quantity
          OR l.goods_cost_vnd <> COALESCE((SELECT sum(b.goods_cost_vnd) FROM store_receipt_bags b WHERE b.store_receipt_line_id = l.id), 0)
          OR EXISTS (
            SELECT 1 FROM store_receipt_bags b
            WHERE b.store_receipt_line_id = l.id
              AND (
                ((l.outbound_request_line_id IS NULL OR b.bag_number <= l.received_quantity)
                  AND b.price_per_kg_vnd IS DISTINCT FROM l.price_per_kg_vnd)
                OR b.goods_cost_vnd <> floor(b.weight_kg * b.price_per_kg_vnd + 0.5)::bigint
              )
          )
        )
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id
        AND l.received_quantity < l.approved_quantity
        AND (NEW.discrepancy_note IS NULL OR length(btrim(NEW.discrepancy_note)) < 3)
    ) OR NEW.goods_cost_vnd <> COALESCE(
      (SELECT sum(l.goods_cost_vnd) FROM store_receipt_lines l WHERE l.store_receipt_id = NEW.id),
      0
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      JOIN reservations r ON r.outbound_request_line_id = l.outbound_request_line_id
      WHERE l.store_receipt_id = NEW.id AND r.status = 'active' AND r.deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      JOIN outbound_request_lines ol ON ol.id = l.outbound_request_line_id
      WHERE l.store_receipt_id = NEW.id AND ol.received_quantity <> l.received_quantity
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id
        AND l.outbound_request_line_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM warehouse_ledger_entries le
          WHERE le.source_type = 'store_receipt'
            AND le.source_id = NEW.id
            AND le.product_id = l.product_id
            AND le.on_hand_delta = -l.received_quantity
            AND le.reserved_delta = -l.approved_quantity
        )
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id
        AND l.received_quantity < l.approved_quantity
        AND NOT EXISTS (
          SELECT 1 FROM wait_tickets w
          WHERE w.store_id = NEW.store_id
            AND w.product_id = l.product_id
            AND w.status = 'active'
            AND w.deleted_at IS NULL
        )
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id AND l.excess_quantity > 0
        AND (NOT EXISTS (
          SELECT 1 FROM warehouse_ledger_entries le
          WHERE le.source_type = 'store_receipt_excess' AND le.source_id = NEW.id
            AND le.product_id = l.product_id AND le.on_hand_delta = -l.excess_quantity
            AND le.reserved_delta = 0
        ) OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(NEW.unexpected_items) item
          WHERE item->>'productId' = l.product_id::text
            AND (item->>'quantity')::integer = l.excess_quantity
        ))
    ) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.unexpected_items) item
      WHERE NOT EXISTS (
        SELECT 1 FROM store_receipt_lines l WHERE l.store_receipt_id = NEW.id
          AND l.product_id::text = item->>'productId'
          AND l.excess_quantity = (item->>'quantity')::integer
      )
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_bags b
      JOIN store_receipt_lines l ON l.id = b.store_receipt_line_id
      WHERE l.store_receipt_id = NEW.id
        AND NOT EXISTS (
          SELECT 1 FROM store_inventory_bags ib
          JOIN store_inventory_ledger_entries le ON le.store_inventory_bag_id = ib.id
          WHERE ib.source_store_receipt_bag_id = b.id
            AND le.source_type = 'store_receipt_bag'
            AND le.source_id = b.id
            AND le.event_type = 'receive'
        )
    ) THEN
      RAISE EXCEPTION 'store receipt finalization is incomplete or inconsistent'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
