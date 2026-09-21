-- Append a supported default without rewriting immutable configuration history.
-- Existing sessions retain their policy; production sessions were repaired separately
-- with explicit owner approval and before/after audit evidence.
WITH latest AS (
  SELECT * FROM operational_settings_versions ORDER BY version DESC LIMIT 1
), inserted AS (
  INSERT INTO operational_settings_versions
    (version, timezone, snapshot_time, cutoff_time, max_requests_per_store,
     policy_version, idosi_sync_interval_minutes, request_id)
  SELECT version + 1, timezone, snapshot_time, cutoff_time, max_requests_per_store,
    'idosi-round-robin-p0a-p3-v1', idosi_sync_interval_minutes, 'migration:0009'
  FROM latest WHERE policy_version = 'ALLOC-v1.2'
  RETURNING *
)
INSERT INTO audit_logs (request_id, action, entity_type, entity_id, before, after, metadata)
SELECT 'migration:0009', 'OPERATIONAL_POLICY_DEFAULT_UPGRADED',
  'operational_settings_version', inserted.id, to_jsonb(latest), to_jsonb(inserted),
  '{"source":"migration","reason":"align default with supported P0A-P3 round-robin worker"}'::jsonb
FROM inserted CROSS JOIN latest;
