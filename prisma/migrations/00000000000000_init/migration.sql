-- Numera: initial schema.
--
-- Single migration by design. The database is rebuilt from scratch for the damped LS-LMSR engine,
-- and the retired parimutuel / fixed-b LMSR tables have no rows worth migrating — every market,
-- price and position is derived from chain events, so a fresh index rebuilds the whole dataset.
--
-- Includes the TimescaleDB hypertable setup for `price_points`, which Prisma cannot express in the
-- schema and which must run in the same migration as the table it converts.

-- TimescaleDB extension. MUST stay the first statement in this file.
--
-- TimescaleDB refuses `CREATE EXTENSION` once its library has been loaded into the current
-- session, with "extension timescaledb has already been loaded with another version". That is why
-- `prisma migrate reset` fails here: reset drops the hypertables and applies the migration on the
-- same connection, so the library is already loaded by the time this line runs.
--
-- To rebuild the database, do it in two sessions instead of one:
--
--   npx prisma migrate reset --force --skip-generate   # will fail on this line; that is expected
--   npx prisma migrate resolve --rolled-back 00000000000000_init
--   npx prisma migrate deploy                          # fresh connection, extension installs
--
-- The reset still drops everything, so nothing is left behind — only the final apply needs its own
-- connection.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Engine" AS ENUM ('LS_LMSR');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('TRADING', 'RESOLVED', 'INVALID');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL', 'SHORT');

-- CreateEnum
CREATE TYPE "ProposalPhase" AS ENUM ('NONE', 'PROPOSED', 'DISPUTED', 'FINALIZED', 'ARBITRATED', 'RESET');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_login_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlink_address" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "markets" (
    "id" UUID NOT NULL,
    "engine" "Engine" NOT NULL,
    "address" TEXT NOT NULL,
    "market_id" BIGINT NOT NULL,
    "collateral" TEXT NOT NULL,
    "resolver" TEXT NOT NULL,
    "close_time" TIMESTAMP(3) NOT NULL,
    "outcome_count" INTEGER NOT NULL,
    "category_key" TEXT,
    "metadata_hash" TEXT NOT NULL,
    "creator" TEXT NOT NULL,
    "alpha" DECIMAL(78,0) NOT NULL,
    "s_star" DECIMAL(78,0) NOT NULL,
    "seed" DECIMAL(78,0) NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'TRADING',
    "winning_outcome_id" INTEGER,
    "pot" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "surplus" DECIMAL(78,0),
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "image_url" TEXT,
    "created_block" BIGINT NOT NULL,
    "created_tx" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcomes" (
    "id" UUID NOT NULL,
    "market_ref" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "current_price_wad" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "current_shares" DECIMAL(78,0) NOT NULL DEFAULT 0,

    CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "market_ref" UUID NOT NULL,
    "engine" "Engine" NOT NULL,
    "account" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "outcome_index" INTEGER NOT NULL,
    "shares" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "amount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "spread_wad" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "price_wad" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "block_number" BIGINT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "market_ref" UUID NOT NULL,
    "account" TEXT NOT NULL,
    "outcome_index" INTEGER NOT NULL,
    "shares" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "cost_basis" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "realized_pnl" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "redeemed" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_points" (
    "time" TIMESTAMPTZ(6) NOT NULL,
    "market_ref" UUID NOT NULL,
    "outcome_index" INTEGER NOT NULL,
    "price_wad" DECIMAL(78,0) NOT NULL,
    "volume" DECIMAL(78,0) NOT NULL DEFAULT 0,

    CONSTRAINT "price_points_pkey" PRIMARY KEY ("market_ref","outcome_index","time")
);

-- CreateTable
CREATE TABLE "resolver_proposals" (
    "id" UUID NOT NULL,
    "market" TEXT NOT NULL,
    "market_id" BIGINT NOT NULL,
    "phase" "ProposalPhase" NOT NULL DEFAULT 'NONE',
    "proposed_outcome" DECIMAL(78,0),
    "final_outcome" DECIMAL(78,0),
    "proposer" TEXT,
    "disputer" TEXT,
    "bond_token" TEXT,
    "bond" DECIMAL(78,0),
    "dispute_deadline" TIMESTAMP(3),
    "proposed_at" TIMESTAMP(3),
    "disputed_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resolver_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_metadata_drafts" (
    "metadata_hash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "image_url" TEXT,
    "outcome_labels" TEXT[],
    "category_key" TEXT,
    "created_by" TEXT NOT NULL,
    "market_ref" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_metadata_drafts_pkey" PRIMARY KEY ("metadata_hash")
);

-- CreateTable
CREATE TABLE "indexer_cursors" (
    "stream" TEXT NOT NULL,
    "last_block" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_cursors_pkey" PRIMARY KEY ("stream")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_address_key" ON "users"("address");

-- CreateIndex
CREATE UNIQUE INDEX "users_unlink_address_key" ON "users"("unlink_address");

-- CreateIndex
CREATE INDEX "refresh_sessions_user_id_idx" ON "refresh_sessions"("user_id");

-- CreateIndex
CREATE INDEX "refresh_sessions_token_hash_idx" ON "refresh_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "markets_status_idx" ON "markets"("status");

-- CreateIndex
CREATE INDEX "markets_category_key_idx" ON "markets"("category_key");

-- CreateIndex
CREATE INDEX "markets_close_time_idx" ON "markets"("close_time");

-- CreateIndex
CREATE INDEX "markets_engine_idx" ON "markets"("engine");

-- CreateIndex
CREATE UNIQUE INDEX "markets_address_market_id_key" ON "markets"("address", "market_id");

-- CreateIndex
CREATE UNIQUE INDEX "outcomes_market_ref_index_key" ON "outcomes"("market_ref", "index");

-- CreateIndex
CREATE INDEX "trades_market_ref_timestamp_idx" ON "trades"("market_ref", "timestamp");

-- CreateIndex
CREATE INDEX "trades_account_idx" ON "trades"("account");

-- CreateIndex
CREATE INDEX "trades_timestamp_idx" ON "trades"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "trades_tx_hash_log_index_key" ON "trades"("tx_hash", "log_index");

-- CreateIndex
CREATE INDEX "positions_account_idx" ON "positions"("account");

-- CreateIndex
CREATE UNIQUE INDEX "positions_market_ref_account_outcome_index_key" ON "positions"("market_ref", "account", "outcome_index");

-- CreateIndex
CREATE INDEX "price_points_time_idx" ON "price_points"("time");

-- CreateIndex
CREATE INDEX "resolver_proposals_phase_idx" ON "resolver_proposals"("phase");

-- CreateIndex
CREATE UNIQUE INDEX "resolver_proposals_market_market_id_key" ON "resolver_proposals"("market", "market_id");

-- CreateIndex
CREATE INDEX "market_metadata_drafts_created_by_idx" ON "market_metadata_drafts"("created_by");

-- CreateIndex
CREATE INDEX "market_metadata_drafts_market_ref_idx" ON "market_metadata_drafts"("market_ref");

-- AddForeignKey
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markets" ADD CONSTRAINT "markets_category_key_fkey" FOREIGN KEY ("category_key") REFERENCES "categories"("key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_market_ref_fkey" FOREIGN KEY ("market_ref") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_market_ref_fkey" FOREIGN KEY ("market_ref") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_ref_fkey" FOREIGN KEY ("market_ref") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- price_points -> hypertable, partitioned on time (chunks = 7 days).
--
-- Must follow the CREATE TABLE above. `migrate_data` covers the case where a
-- deployment applied the table before this line was added.
-- ---------------------------------------------------------------------------
SELECT create_hypertable(
    'price_points',
    'time',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE,
    migrate_data => TRUE
);
