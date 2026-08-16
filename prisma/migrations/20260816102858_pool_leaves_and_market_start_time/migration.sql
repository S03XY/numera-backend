-- CreateEnum
CREATE TYPE "PoolLeafKind" AS ENUM ('DEPOSIT', 'CHANGE');

-- AlterTable
--
-- `start_time` is NOT NULL, and markets already exist. Rather than reset the database, existing
-- rows are backfilled from `created_at`: they were created before the engine had a start time, so
-- they opened the moment they were created, and a start time equal to creation is exactly true of
-- them. The engine does the same thing for a market whose creator names no start.
--
-- Added nullable, backfilled, then constrained — three statements rather than one, because
-- `ADD COLUMN ... NOT NULL` with no default fails outright on a non-empty table.
ALTER TABLE "markets" ADD COLUMN "start_time" TIMESTAMP(3);
UPDATE "markets" SET "start_time" = "created_at" WHERE "start_time" IS NULL;
ALTER TABLE "markets" ALTER COLUMN "start_time" SET NOT NULL;

-- CreateTable
CREATE TABLE "pool_leaves" (
    "id" BIGSERIAL NOT NULL,
    "block_number" BIGINT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "kind" "PoolLeafKind" NOT NULL,
    "commitment" TEXT NOT NULL,
    "label" TEXT,
    "value" TEXT NOT NULL,
    "precommitment" TEXT,
    "spent_nullifier" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pool_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pool_leaves_block_number_log_index_idx" ON "pool_leaves"("block_number", "log_index");

-- CreateIndex
CREATE UNIQUE INDEX "pool_leaves_tx_hash_log_index_key" ON "pool_leaves"("tx_hash", "log_index");
