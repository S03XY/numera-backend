-- CreateEnum
CREATE TYPE "ResolutionPhase" AS ENUM ('NONE', 'PROPOSED', 'DISPUTED', 'SETTLED');

-- CreateEnum
CREATE TYPE "ResolutionRoute" AS ENUM ('FINALIZED', 'ARBITRATED');

-- CreateTable
CREATE TABLE "resolution_proposals" (
    "id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "market_id" BIGINT NOT NULL,
    "market_ref" UUID,
    "phase" "ResolutionPhase" NOT NULL DEFAULT 'NONE',
    "proposer" TEXT,
    "proposed_outcome" INTEGER,
    "proposer_bonded" BOOLEAN NOT NULL DEFAULT false,
    "proposer_bond" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "dispute_deadline" TIMESTAMP(3),
    "disputer" TEXT,
    "counter_outcome" INTEGER,
    "disputer_bond" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "arbitration_deadline" TIMESTAMP(3),
    "route" "ResolutionRoute",
    "settled_outcome" INTEGER,
    "reward" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "forfeited" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "loser" TEXT,
    "settled_at" TIMESTAMP(3),
    "proposed_tx" TEXT,
    "settled_tx" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resolution_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banned_accounts" (
    "account" TEXT NOT NULL,
    "context" TEXT,
    "market_id" BIGINT,
    "banned_at" TIMESTAMP(3) NOT NULL,
    "lifted_at" TIMESTAMP(3),
    "tx_hash" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "banned_accounts_pkey" PRIMARY KEY ("account")
);

-- CreateIndex
CREATE INDEX "resolution_proposals_phase_idx" ON "resolution_proposals"("phase");

-- CreateIndex
CREATE INDEX "resolution_proposals_dispute_deadline_idx" ON "resolution_proposals"("dispute_deadline");

-- CreateIndex
CREATE INDEX "resolution_proposals_market_ref_idx" ON "resolution_proposals"("market_ref");

-- CreateIndex
CREATE UNIQUE INDEX "resolution_proposals_address_market_id_key" ON "resolution_proposals"("address", "market_id");

-- CreateIndex
CREATE INDEX "banned_accounts_lifted_at_idx" ON "banned_accounts"("lifted_at");
