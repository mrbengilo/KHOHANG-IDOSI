ALTER TABLE operational_settings_versions ADD COLUMN vat_rate_percent integer NOT NULL DEFAULT 8;
--> statement-breakpoint
ALTER TABLE operational_settings_versions ADD CONSTRAINT operational_settings_vat_rate_valid CHECK (vat_rate_percent BETWEEN 0 AND 100);
--> statement-breakpoint
ALTER TABLE store_receipts ADD COLUMN vat_settings_version integer REFERENCES operational_settings_versions(version);
--> statement-breakpoint
ALTER TABLE store_receipts DROP CONSTRAINT store_receipts_vat_valid;
--> statement-breakpoint
ALTER TABLE store_receipts ADD CONSTRAINT store_receipts_vat_valid CHECK (
  (vat_amount_vnd IS NULL AND vat_rate_percent IS NULL) OR
  (vat_amount_vnd IS NOT NULL AND vat_rate_percent IS NOT NULL AND vat_amount_vnd BETWEEN 0 AND 9007199254740991 AND vat_rate_percent BETWEEN 0 AND 100)
);
