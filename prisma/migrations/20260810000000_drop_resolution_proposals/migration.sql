-- Drop the bonded-proposal read model.
--
-- Phase 1 settles markets from the operator's own quorum. Bonded, permissionless proposals were
-- built and deployed, then taken out before launch: a bond only deters a liar if somebody
-- challenges, and with shielded positions no third party can see that a false proposal is worth
-- challenging. On a market with no watchers the challenge window was decorative.
--
-- Settled state is not lost with the table. It lives on `markets.status` and
-- `markets.winning_outcome_id`, written from the engine's own `MarketResolved` /
-- `MarketInvalidated` events, which is where the UI reads it from.
--
-- The contracts are preserved outside the build tree at `contracts/reference/phase2/`, along with
-- what they need before they go back in.

DROP TABLE IF EXISTS "resolution_proposals";
DROP TYPE IF EXISTS "ResolutionPhase";
