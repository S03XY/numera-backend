import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PricesService } from './prices.service';
import { CandleInterval, CandlesQueryDto } from './dto/candles.dto';

describe('PricesService', () => {
  it('recordPoint truncates time to the second and upserts (positive)', async () => {
    const upsert = jest.fn(async () => undefined) as jest.Mock;
    const prisma = { pricePoint: { upsert } } as unknown as PrismaService;
    const svc = new PricesService(prisma);

    await svc.recordPoint({
      marketRef: 'm1',
      outcomeIndex: 0,
      priceWad: 500000000000000000n,
      volume: 1000n,
      timestamp: new Date('2026-01-01T00:00:01.777Z'),
    });

    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.where.marketRef_outcomeIndex_time.time.getMilliseconds()).toBe(0);
    expect(arg.create.priceWad.toString()).toBe('500000000000000000');
  });

  it('candles maps raw time_bucket rows to OHLC (positive)', async () => {
    const rows = [
      {
        bucket: new Date('2026-01-01T00:00:00Z'),
        open: new Prisma.Decimal('1'),
        high: new Prisma.Decimal('3'),
        low: new Prisma.Decimal('1'),
        close: new Prisma.Decimal('2'),
        volume: new Prisma.Decimal('100'),
      },
    ];
    const prisma = { $queryRaw: jest.fn(async () => rows) } as unknown as PrismaService;
    const svc = new PricesService(prisma);

    const dto: CandlesQueryDto = { interval: CandleInterval.M1, outcome: 0, limit: 500 };
    const candles = await svc.candles('m1', dto);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: '1', high: '3', low: '1', close: '2', volume: '100' });
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('latest reads current prices from outcomes (positive)', async () => {
    const prisma = {
      outcome: {
        findMany: jest.fn(async () => [
          { index: 0, currentPriceWad: new Prisma.Decimal('600000000000000000') },
          { index: 1, currentPriceWad: new Prisma.Decimal('400000000000000000') },
        ]),
      },
    } as unknown as PrismaService;
    const svc = new PricesService(prisma);
    const latest = await svc.latest('m1');
    expect(latest).toEqual([
      { outcomeIndex: 0, priceWad: '600000000000000000' },
      { outcomeIndex: 1, priceWad: '400000000000000000' },
    ]);
  });
});

describe('PricesService.sparklines', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  function svcWith(rows: unknown[]) {
    const $queryRaw = jest.fn(async () => rows);
    const prisma = { $queryRaw } as unknown as PrismaService;
    return { svc: new PricesService(prisma), $queryRaw };
  }

  it('groups rows by market and preserves bucket order (positive)', async () => {
    const { svc } = svcWith([
      { market_ref: A, bucket: new Date('2026-01-01T00:00:00Z'), close: new Prisma.Decimal('1') },
      { market_ref: A, bucket: new Date('2026-01-01T01:00:00Z'), close: new Prisma.Decimal('2') },
      { market_ref: B, bucket: new Date('2026-01-01T00:00:00Z'), close: new Prisma.Decimal('9') },
    ]);

    const out = await svc.sparklines({ markets: [A, B], outcome: 0, hours: 24 });
    expect(out).toEqual([
      { marketRef: A, points: ['1', '2'] },
      { marketRef: B, points: ['9'] },
    ]);
  });

  it('returns results in the order asked for, not the order the database gave (regression)', async () => {
    // The client zips this against its own market list. Trusting Postgres's ordering of a
    // `= ANY(...)` scan would silently pair one market's line with another's card.
    const { svc } = svcWith([
      { market_ref: B, bucket: new Date('2026-01-01T00:00:00Z'), close: new Prisma.Decimal('9') },
      { market_ref: A, bucket: new Date('2026-01-01T00:00:00Z'), close: new Prisma.Decimal('1') },
    ]);

    const out = await svc.sparklines({ markets: [A, B], outcome: 0, hours: 24 });
    expect(out.map((s) => s.marketRef)).toEqual([A, B]);
  });

  it('omits markets with no price history rather than returning empty series (negative)', async () => {
    // Absent and empty mean different things to the caller: "never traded" versus "asked for".
    const { svc } = svcWith([
      { market_ref: A, bucket: new Date('2026-01-01T00:00:00Z'), close: new Prisma.Decimal('1') },
    ]);

    const out = await svc.sparklines({ markets: [A, B], outcome: 0, hours: 24 });
    expect(out).toHaveLength(1);
    expect(out[0].marketRef).toBe(A);
  });

  it('scales the bucket to the window so every range returns a similar point count (positive)', async () => {
    const { svc, $queryRaw } = svcWith([]);
    await svc.sparklines({ markets: [A], outcome: 0, hours: 24 });
    await svc.sparklines({ markets: [A], outcome: 0, hours: 1 });

    // Bucket width is a bound parameter, never interpolated text — the value is computed, so it
    // must not reach Postgres as SQL.
    const wide = $queryRaw.mock.calls[0].slice(1);
    const narrow = $queryRaw.mock.calls[1].slice(1);
    expect(wide).toContain(36); // 24h over 40 points → 36-minute buckets
    expect(narrow).toContain(2); // 1h over 40 points → 1.5 min, rounded to 2
  });
});
