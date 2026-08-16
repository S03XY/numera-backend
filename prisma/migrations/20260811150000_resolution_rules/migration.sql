-- How each market settles, published at creation and committed to `metadataHash`.
--
-- Defaulted to empty rather than made NOT NULL without one, because markets created before this
-- existed have no rules to backfill and inventing some would be worse than showing none. New
-- drafts require it: see `CreateMetadataDraftDto`.
ALTER TABLE "market_metadata_drafts" ADD COLUMN "resolution_rules" TEXT NOT NULL DEFAULT '';
ALTER TABLE "markets" ADD COLUMN "resolution_rules" TEXT NOT NULL DEFAULT '';
