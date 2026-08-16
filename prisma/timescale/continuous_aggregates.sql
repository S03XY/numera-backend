-- Optional TimescaleDB continuous aggregates for fast OHLC candles.
-- Run OUTSIDE a transaction (continuous aggregates cannot be created inside one),
-- which is why this is separate from the Prisma migration. Idempotent.
--
-- The prices module can query these views directly, or fall back to on-the-fly
-- time_bucket() over the price_points hypertable (also fast) if these are absent.

-- 1-minute candles
CREATE MATERIALIZED VIEW IF NOT EXISTS price_candles_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', "time") AS bucket,
    "market_ref",
    "outcome_index",
    first("price_wad", "time") AS open,
    max("price_wad")          AS high,
    min("price_wad")          AS low,
    last("price_wad", "time") AS close,
    sum("volume")             AS volume
FROM "price_points"
GROUP BY bucket, "market_ref", "outcome_index"
WITH NO DATA;

-- 1-hour candles
CREATE MATERIALIZED VIEW IF NOT EXISTS price_candles_1h
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', "time") AS bucket,
    "market_ref",
    "outcome_index",
    first("price_wad", "time") AS open,
    max("price_wad")          AS high,
    min("price_wad")          AS low,
    last("price_wad", "time") AS close,
    sum("volume")             AS volume
FROM "price_points"
GROUP BY bucket, "market_ref", "outcome_index"
WITH NO DATA;

-- Keep the aggregates fresh automatically.
SELECT add_continuous_aggregate_policy('price_candles_1m',
    start_offset => INTERVAL '3 hours',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE);

SELECT add_continuous_aggregate_policy('price_candles_1h',
    start_offset => INTERVAL '3 days',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
