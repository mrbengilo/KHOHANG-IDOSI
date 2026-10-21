-- Finalizing a receipt with a discrepancy failed with an unexpected 500 in two cases the
-- application handles correctly but the 0042 trigger still rejected:
--   * excess bags of a Reshare-reconciled SKU (by design A writes no ledger row: B counted them);
--   * a shortage whose wait was allocated, cancelled or merged before HTKD finalized.
-- Only these two predicates change; every other check is kept as in 0042.
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
      WHERE l.store_receipt_id = NEW.id AND r.status IN ('active', 'issued') AND r.deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      JOIN outbound_request_lines ol ON ol.id = l.outbound_request_line_id
      WHERE l.store_receipt_id = NEW.id AND ol.received_quantity <> l.received_quantity
    ) OR EXISTS (
      SELECT 1
      FROM store_receipt_lines l
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(s.quantity), 0)::integer AS issued_quantity,
               COALESCE(sum(s.received_quantity), 0)::integer AS issued_received
        FROM reshare_order_sources s
        WHERE s.settled_store_receipt_id = NEW.id
          AND s.settled_outbound_request_line_id = l.outbound_request_line_id
      ) issued
      WHERE l.store_receipt_id = NEW.id
        AND l.outbound_request_line_id IS NOT NULL
        AND (
          issued.issued_quantity > l.approved_quantity
          OR issued.issued_received > l.received_quantity
          OR (l.received_quantity - issued.issued_received) > (l.approved_quantity - issued.issued_quantity)
          OR (
            l.approved_quantity > issued.issued_quantity
            AND NOT EXISTS (
              SELECT 1 FROM warehouse_ledger_entries le
              WHERE le.source_type = 'store_receipt'
                AND le.source_id = NEW.id
                AND le.product_id = l.product_id
                AND le.on_hand_delta = -(l.received_quantity - issued.issued_received)
                AND le.reserved_delta = -(l.approved_quantity - issued.issued_quantity)
            )
          )
          OR (
            l.approved_quantity = issued.issued_quantity
            AND EXISTS (
              SELECT 1 FROM warehouse_ledger_entries le
              WHERE le.source_type = 'store_receipt'
                AND le.source_id = NEW.id
                AND le.product_id = l.product_id
            )
          )
        )
    ) OR EXISTS (
      -- The shortage is queued when the store submits, often days before HTKD finalizes; by then
      -- its wait may already be allocated, cancelled or merged. What must hold is that this
      -- receipt recorded the queued shortage and the demand reached the store's waitlist.
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id
        AND l.received_quantity < l.approved_quantity
        AND (
          l.priority_queued_quantity <> l.approved_quantity - l.received_quantity
          OR NOT EXISTS (
            SELECT 1 FROM wait_tickets w
            WHERE w.store_id = NEW.store_id
              AND w.product_id = l.product_id
              AND w.deleted_at IS NULL
          )
        )
    ) OR EXISTS (
      SELECT 1 FROM store_receipt_lines l
      WHERE l.store_receipt_id = NEW.id AND l.excess_quantity > 0
        -- Exactly one booking: out of A's unreserved stock, or, for a Reshare-reconciled SKU,
        -- no A deduction (B already counted it) and the SKU flagged for a new observation.
        AND (EXISTS (
          SELECT 1 FROM warehouse_ledger_entries le
          WHERE le.source_type = 'store_receipt_excess' AND le.source_id = NEW.id
            AND le.product_id = l.product_id AND le.on_hand_delta = -l.excess_quantity
            AND le.reserved_delta = 0
        ) = EXISTS (
          SELECT 1 FROM audit_logs a
          WHERE a.action = 'SUPPLIER_RECEIPT_EXCESS_NEEDS_RECONCILIATION'
            AND a.entity_type = 'store_receipt' AND a.entity_id = NEW.id
            AND a.after->>'productId' = l.product_id::text
            AND (a.after->>'quantity')::integer = l.excess_quantity
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
