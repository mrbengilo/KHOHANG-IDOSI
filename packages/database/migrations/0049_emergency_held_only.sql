-- Expand: keep existing emergency writes valid while allowing shipments backed entirely by old REs.
-- No rows, quantities, ledger entries or historical RE documents are changed.
CREATE OR REPLACE FUNCTION emergency_priority_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM outbound_requests o
    WHERE o.id=NEW.outbound_request_id AND o.store_id=NEW.store_id
      AND o.status='dispatched' AND o.allocation_run_id IS NULL AND o.order_session_id IS NULL
  ) OR NEW.total_quantity <> (
    SELECT coalesce(sum(r.quantity),0) FROM emergency_priority_sources s
    JOIN reservations r ON r.id=s.reservation_id WHERE s.order_id=NEW.id
  ) OR EXISTS (
    SELECT 1 FROM emergency_priority_sources s
    JOIN reservations r ON r.id=s.reservation_id
    LEFT JOIN outbound_request_lines ol ON ol.id=r.outbound_request_line_id
    LEFT JOIN reshare_order_sources rs ON rs.reservation_id=r.id
    LEFT JOIN reshare_orders re ON re.id=rs.reshare_order_id
    WHERE s.order_id=NEW.id AND (
      r.status<>'issued' OR r.deleted_at IS NOT NULL OR r.consumed_quantity<>0
      OR r.store_id<>NEW.store_id
      OR ol.outbound_request_id IS DISTINCT FROM NEW.outbound_request_id
      OR ol.product_id IS DISTINCT FROM r.product_id
      OR rs.id IS NULL OR rs.settled_at IS NOT NULL
      OR rs.store_id IS DISTINCT FROM NEW.store_id
      OR rs.product_id IS DISTINCT FROM r.product_id
      OR rs.quantity IS DISTINCT FROM r.quantity
      OR re.store_id IS DISTINCT FROM NEW.store_id
      OR (s.kind='additional' AND re.emergency_order_id IS DISTINCT FROM NEW.id)
    )
  ) THEN RAISE EXCEPTION 'Incomplete emergency order' USING ERRCODE='IDR04'; END IF;
  RETURN NULL;
END; $$;
