-- Additive provenance for returns completed by approval, without fabricated physical handovers.
-- Existing return rows and their operational workflow remain unchanged.
ALTER TABLE store_receipt_returns ADD COLUMN auto_completed_at timestamptz;
--> statement-breakpoint
ALTER TABLE store_receipt_returns ADD COLUMN auto_completed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE store_receipt_returns DROP CONSTRAINT store_receipt_returns_handover_state;
--> statement-breakpoint
ALTER TABLE store_receipt_returns ADD CONSTRAINT store_receipt_returns_handover_state CHECK (
  auto_completed_at IS NOT NULL OR status IN ('pending_handover', 'cancelled') OR
  (handed_over_by_user_id IS NOT NULL AND handed_over_at IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE store_receipt_returns DROP CONSTRAINT store_receipt_returns_receive_state;
--> statement-breakpoint
ALTER TABLE store_receipt_returns ADD CONSTRAINT store_receipt_returns_receive_state CHECK (
  auto_completed_at IS NOT NULL OR status IN ('pending_handover', 'in_transit', 'cancelled') OR
  (received_by_user_id IS NOT NULL AND received_at IS NOT NULL AND received_quantity IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE store_receipt_returns ADD CONSTRAINT store_receipt_returns_auto_completion CHECK (
  (auto_completed_at IS NULL AND auto_completed_by_user_id IS NULL) OR
  (auto_completed_at IS NOT NULL AND auto_completed_by_user_id IS NOT NULL AND status = 'received'
   AND received_quantity IS NOT NULL AND received_quantity = quantity AND handed_over_at IS NULL AND handed_over_by_user_id IS NULL
   AND received_at IS NULL AND received_by_user_id IS NULL)
);
--> statement-breakpoint
CREATE INDEX store_receipt_returns_effective_store_idx
  ON store_receipt_returns (coalesce(auto_completed_at, handed_over_at), store_id)
  WHERE coalesce(auto_completed_at, handed_over_at) IS NOT NULL;
