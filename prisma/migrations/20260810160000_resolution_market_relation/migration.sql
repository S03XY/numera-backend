-- Give a market at most one resolution row, and let Postgres enforce it.
--
-- `market_ref` stays nullable: a proposal can be indexed before the market it is about, since the
-- resolver is a separate contract on a separate stream, and dropping it in that window would lose
-- the proposal. Postgres allows many NULLs under a unique index, which is exactly the shape needed.
--
-- The stale index from the first migration is dropped: a plain index and a unique index on the same
-- column is one index too many, and the unique one already serves both purposes.
DROP INDEX IF EXISTS "resolution_proposals_market_ref_idx";

CREATE UNIQUE INDEX "resolution_proposals_market_ref_key" ON "resolution_proposals"("market_ref");

ALTER TABLE "resolution_proposals"
  ADD CONSTRAINT "resolution_proposals_market_ref_fkey"
  FOREIGN KEY ("market_ref") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
