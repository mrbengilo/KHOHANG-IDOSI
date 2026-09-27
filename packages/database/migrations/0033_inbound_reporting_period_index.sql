-- Date first also supports all-store day/month reports; store_id narrows scoped reports.
-- Match the report's exact predicate and keep pending/deleted documents out of the index.
CREATE INDEX store_receipts_finalized_period_idx
  ON store_receipts (finalized_at, store_id)
  WHERE status = 'finalized' AND deleted_at IS NULL;
