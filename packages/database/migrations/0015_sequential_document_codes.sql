-- Public document numbers are separate from immutable UUID keys. The counter update
-- takes a row lock and rolls back with the document insert, so concurrent writers
-- cannot allocate the same number or leave a gap after a failed transaction.
CREATE TABLE document_code_counters (
  prefix text PRIMARY KEY,
  last_number integer NOT NULL CHECK (last_number >= 0)
);

CREATE FUNCTION next_document_code(code_prefix text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE allocated integer;
BEGIN
  INSERT INTO document_code_counters(prefix, last_number) VALUES (code_prefix, 1)
  ON CONFLICT (prefix) DO UPDATE
    SET last_number = document_code_counters.last_number + 1
  RETURNING last_number INTO allocated;
  IF allocated >= power(10, 9 - length(code_prefix)) THEN
    RAISE EXCEPTION 'Document code space exhausted for %', code_prefix;
  END IF;
  RETURN code_prefix || '-' || lpad(allocated::text, 9 - length(code_prefix), '0');
END;
$$;

CREATE FUNCTION assign_document_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE code_prefix text := TG_ARGV[1];
BEGIN
  IF TG_ARGV[0] = 'outbound_number' THEN
    IF NEW.reason::text <> 'discount_sale' THEN
      code_prefix := 'PXL';
    END IF;
  END IF;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], next_document_code(code_prefix)));
  RETURN NEW;
END;
$$;

ALTER TABLE order_requests ADD COLUMN code text NOT NULL DEFAULT '';
ALTER TABLE wait_tickets ADD COLUMN code text NOT NULL DEFAULT '';
ALTER TABLE daily_priority_offers ADD COLUMN code text NOT NULL DEFAULT '';

-- Assign existing documents in creation order. Original UUIDs stay intact.
DO $$
DECLARE spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('order_sessions', 'code', 'PDH'),
      ('order_requests', 'code', 'PDT'),
      ('wait_tickets', 'code', 'PC'),
      ('daily_priority_offers', 'code', 'PUT'),
      ('outbound_requests', 'request_number', 'PXK'),
      ('store_receipts', 'receipt_number', 'PNH'),
      ('store_transfers', 'transfer_number', 'PDC')
    ) AS t(table_name, column_name, prefix)
  LOOP
    EXECUTE format(
      'WITH numbered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM %I)
       UPDATE %I AS target SET %I = %L || ''-'' || lpad(numbered.n::text, 9 - length(%L), ''0'')
       FROM numbered WHERE target.id = numbered.id',
      spec.table_name, spec.table_name, spec.column_name, spec.prefix, spec.prefix
    );
    EXECUTE format(
      'INSERT INTO document_code_counters(prefix, last_number) SELECT %L, count(*)::integer FROM %I',
      spec.prefix, spec.table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION assign_document_code(%L, %L)',
      spec.table_name || '_sequential_code_insert', spec.table_name, spec.column_name, spec.prefix
    );
  END LOOP;
END;
$$;

WITH numbered AS (
  SELECT id, CASE WHEN reason = 'discount_sale' THEN 'PBL' ELSE 'PXL' END AS prefix,
    row_number() OVER (
      PARTITION BY CASE WHEN reason = 'discount_sale' THEN 'PBL' ELSE 'PXL' END
      ORDER BY created_at, id
    ) AS n
  FROM store_outbounds
)
UPDATE store_outbounds AS target
SET outbound_number = numbered.prefix || '-' || lpad(numbered.n::text, 6, '0')
FROM numbered WHERE target.id = numbered.id;
INSERT INTO document_code_counters(prefix, last_number)
SELECT prefix, count(*)::integer FROM (
  SELECT CASE WHEN reason = 'discount_sale' THEN 'PBL' ELSE 'PXL' END AS prefix
  FROM store_outbounds
) numbered GROUP BY prefix;
CREATE TRIGGER store_outbounds_sequential_code_insert BEFORE INSERT ON store_outbounds
FOR EACH ROW EXECUTE FUNCTION assign_document_code('outbound_number', 'PBL');

CREATE UNIQUE INDEX order_requests_code_uidx ON order_requests(code);
CREATE UNIQUE INDEX wait_tickets_code_uidx ON wait_tickets(code);
CREATE UNIQUE INDEX daily_priority_offers_code_uidx ON daily_priority_offers(code);

-- The number of digits is fixed by the ten-character format for each prefix.
ALTER TABLE order_sessions ADD CONSTRAINT order_sessions_short_code CHECK (code ~ '^PDH-[0-9]{6}$');
ALTER TABLE order_requests ADD CONSTRAINT order_requests_short_code CHECK (code ~ '^PDT-[0-9]{6}$');
ALTER TABLE wait_tickets ADD CONSTRAINT wait_tickets_short_code CHECK (code ~ '^PC-[0-9]{7}$');
ALTER TABLE daily_priority_offers ADD CONSTRAINT priority_offers_short_code CHECK (code ~ '^PUT-[0-9]{6}$');
ALTER TABLE outbound_requests ADD CONSTRAINT outbound_requests_short_code CHECK (request_number ~ '^PXK-[0-9]{6}$');
ALTER TABLE store_receipts ADD CONSTRAINT store_receipts_short_code CHECK (receipt_number ~ '^PNH-[0-9]{6}$');
ALTER TABLE store_transfers ADD CONSTRAINT store_transfers_short_code CHECK (transfer_number ~ '^PDC-[0-9]{6}$');
ALTER TABLE store_outbounds ADD CONSTRAINT store_outbounds_short_code CHECK (outbound_number ~ '^PBL-[0-9]{6}$' OR outbound_number ~ '^PXL-[0-9]{6}$');
