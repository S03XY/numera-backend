-- Bonded resolution proposals, mirrored from PrivateOptimisticResolver.
--
-- Not a revival of the table dropped in 20260809000000. That one tracked a contract no market was
-- ever bound to, and its shape assumed a public proposer. This one records proposals made from
-- market execution accounts through a relay, so the addresses are unlinkable by construction, and
-- it carries the reward and the slashed bond the earlier design had no notion of.

CREATE TYPE "ResolutionPhase" AS ENUM (
  'PROPOSED', 'DISPUTED', 'FINALIZED', 'ARBITRATED', 'RESET', 'ABANDONED', 'OPERATOR'
);

CREATE TABLE "resolution_proposals" (
    "id" UUID NOT NULL,
    "market" TEXT NOT NULL,
    "market_id" BIGINT NOT NULL,
    "phase" "ResolutionPhase" NOT NULL,
    "proposed_outcome" DECIMAL(78,0),
    "final_outcome" DECIMAL(78,0),
    "proposer" TEXT,
    "disputer" TEXT,
    "bond" DECIMAL(78,0),
    "reward" DECIMAL(78,0),
    "winner" TEXT,
    "dispute_deadline" TIMESTAMP(3),
    "arbitration_deadline" TIMESTAMP(3),
    "proposed_at" TIMESTAMP(3),
    "disputed_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resolution_proposals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "resolution_proposals_market_market_id_key"
  ON "resolution_proposals"("market", "market_id");
CREATE INDEX "resolution_proposals_phase_idx" ON "resolution_proposals"("phase");
