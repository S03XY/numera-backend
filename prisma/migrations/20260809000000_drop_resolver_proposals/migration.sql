-- Drop the optimistic-resolution read model.
--
-- Numera settles through one resolver, gated by a signer quorum (`ResolverMultisig`), so there are
-- no bonded proposals, no dispute window and no arbitration to index. Every row here described a
-- mechanism no live market was ever bound to: all markets pointed at `TrustedResolver`, and the
-- `OptimisticResolver` these rows tracked was deployed but never referenced.
--
-- Settled state is not lost with the table — it lives on `markets.status` and
-- `markets.winning_outcome_id`, written from the engine's own `MarketResolved` / `MarketInvalidated`
-- events, which is where the UI reads it from anyway.
--
-- Written as a second migration rather than an edit to `00000000000000_init` so an already-indexed
-- database applies it in place. Editing the init file would change its checksum and force a full
-- reset, which on this schema means re-running the TimescaleDB dance documented there.

DROP TABLE IF EXISTS "resolver_proposals";
DROP TYPE IF EXISTS "ProposalPhase";
