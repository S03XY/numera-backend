import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CandleInterval, INTERVAL_SQL, CandlesQueryDto } from './dto/candles.dto';
import { SparklinesQueryDto } from './dto/sparklines.dto';

export interface Sparkline {
  marketRef: string;
  /** Bucketed closing prices, WAD, oldest first. */
  points: string[];
}

export interface Candle {
  time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface RawCandle {
  bucket: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
}

export interface PricePointInput {
  marketRef: string;
  outcomeIndex: number;
  priceWad: bigint;
  volume: bigint;
  timestamp: Date;
}

@Injectable()
export class PricesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append a price sample. `time` is truncated to the second so many trades in
   * the same second collapse to the latest price (keeps the series chart-sized);
   * the exact per-trade record lives in the trades table.
   */
  async recordPoint(p: PricePointInput): Promise<void> {
    const time = new Date(Math.floor(p.timestamp.getTime() / 1000) * 1000);
    await this.prisma.pricePoint.upsert({
      where: {
        marketRef_outcomeIndex_time: {
          marketRef: p.marketRef,
          outcomeIndex: p.outcomeIndex,
          time,
        },
      },
      create: {
        marketRef: p.marketRef,
        outcomeIndex: p.outcomeIndex,
        time,
        priceWad: new Prisma.Decimal(p.priceWad.toString()),
        volume: new Prisma.Decimal(p.volume.toString()),
      },
      update: {
        priceWad: new Prisma.Decimal(p.priceWad.toString()),
        volume: { increment: new Prisma.Decimal(p.volume.toString()) },
      },
    });
  }

  /** OHLC candles via TimescaleDB time_bucket over the hypertable. */
  async candles(marketRef: string, dto: CandlesQueryDto): Promise<Candle[]> {
    const intervalSql = INTERVAL_SQL[dto.interval as CandleInterval];
    const to = dto.to ? new Date(dto.to) : new Date();
    const from = dto.from ? new Date(dto.from) : new Date(to.getTime() - 24 * 3600 * 1000);

    const rows = await this.prisma.$queryRaw<RawCandle[]>`
      SELECT
        time_bucket(${intervalSql}::interval, "time") AS bucket,
        first("price_wad", "time") AS open,
        max("price_wad")           AS high,
        min("price_wad")           AS low,
        last("price_wad", "time")  AS close,
        sum("volume")              AS volume
      FROM "price_points"
      WHERE "market_ref" = ${marketRef}::uuid
        AND "outcome_index" = ${dto.outcome}
        AND "time" >= ${from}
        AND "time" <= ${to}
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT ${dto.limit}
    `;

    return rows.map((r) => ({
      time: r.bucket.toISOString(),
      open: r.open.toString(),
      high: r.high.toString(),
      low: r.low.toString(),
      close: r.close.toString(),
      volume: r.volume.toString(),
    }));
  }

  /**
   * One outcome's recent shape for many markets, in a single query.
   *
   * Bucket width is derived from the window rather than fixed, so a 1-hour request and a 30-day
   * request both come back at roughly forty points: enough to draw a legible line, few enough
   * that a full board of them is a few kilobytes.
   *
   * Markets with no price history are simply absent from the result. Returning empty rows for
   * them would make the caller unable to tell "no trades yet" from "not asked for".
   */
  async sparklines(dto: SparklinesQueryDto): Promise<Sparkline[]> {
    const TARGET_POINTS = 40;
    const bucketMinutes = Math.max(1, Math.round((dto.hours * 60) / TARGET_POINTS));
    const from = new Date(Date.now() - dto.hours * 3600 * 1000);

    // `make_interval` rather than string interpolation: the width is computed, so it must reach
    // Postgres as a bound parameter and never as SQL text.
    const rows = await this.prisma.$queryRaw<
      { market_ref: string; bucket: Date; close: Prisma.Decimal }[]
    >`
      SELECT
        "market_ref",
        time_bucket(make_interval(mins => ${bucketMinutes}::int), "time") AS bucket,
        last("price_wad", "time") AS close
      FROM "price_points"
      WHERE "market_ref" = ANY(${dto.markets}::uuid[])
        AND "outcome_index" = ${dto.outcome}
        AND "time" >= ${from}
      GROUP BY "market_ref", bucket
      ORDER BY "market_ref", bucket ASC
    `;

    const byMarket = new Map<string, string[]>();
    for (const r of rows) {
      const list = byMarket.get(r.market_ref);
      if (list) list.push(r.close.toString());
      else byMarket.set(r.market_ref, [r.close.toString()]);
    }

    // Emitted in the caller's requested order so the client can zip it against its own list.
    return dto.markets
      .filter((m) => byMarket.has(m))
      .map((marketRef) => ({ marketRef, points: byMarket.get(marketRef)! }));
  }

  /** Latest price per outcome for a market (maintained on the outcomes table). */
  async latest(marketRef: string): Promise<{ outcomeIndex: number; priceWad: string }[]> {
    const outcomes = await this.prisma.outcome.findMany({
      where: { marketRef },
      orderBy: { index: 'asc' },
      select: { index: true, currentPriceWad: true },
    });
    return outcomes.map((o) => ({
      outcomeIndex: o.index,
      priceWad: o.currentPriceWad.toString(),
    }));
  }
}
