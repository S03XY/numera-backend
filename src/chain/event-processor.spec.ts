import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PricesService } from '../prices/prices.service';
import { MarketsService } from '../markets/markets.service';
import { ChainService } from './chain.service';
import { EventProcessor, NormalizedLog } from './event-processor.service';

const WAD = 10n ** 18n;

function log(partial: Partial<NormalizedLog> & Pick<NormalizedLog, 'kind' | 'eventName' | 'args'>): NormalizedLog {
  return {
    address: '0xengine',
    blockNumber: 10n,
    txHash: '0xtx',
    logIndex: 0,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    ...partial,
  };
}

interface Fakes {
  prisma: any;
  redis: RedisService;
  prices: PricesService;
  markets: MarketsService;
  chain: ChainService;
  processor: EventProcessor;
}

function makeFakes(marketFindUnique?: jest.Mock): Fakes {
  const prisma: any = {
    market: {
      findUnique:
        marketFindUnique ??
        jest.fn(async () => ({ id: 'm1', address: '0xengine', marketId: 1n })),
      update: jest.fn(async () => ({})),
      upsert: jest.fn(async () => ({ id: 'm1' })),
    },
    outcome: { update: jest.fn(async () => ({})) },
    trade: { upsert: jest.fn(async () => ({})) },
    position: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    category: { upsert: jest.fn(async () => ({})) },
  };
  const redis = { publish: jest.fn(async () => undefined), del: jest.fn(async () => undefined) } as unknown as RedisService;
  const prices = { recordPoint: jest.fn(async () => undefined) } as unknown as PricesService;
  const markets = { invalidate: jest.fn(async () => undefined) } as unknown as MarketsService;
  const chain = { isReady: false, readPrices: jest.fn() } as unknown as ChainService;
  const processor = new EventProcessor(prisma as PrismaService, redis, prices, markets, chain);
  return { prisma, redis, prices, markets, chain, processor };
}

describe('EventProcessor', () => {
  it('buy: increments pot by cost, records the trade and opens a position (positive)', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({
        kind: 'LS_LMSR',
        eventName: 'Bought',
        args: { marketId: 1n, account: '0xACC', outcomeId: 0n, shares: 100n, cost: 42n, spreadWad: 5n },
      }),
    ]);

    const trade = prisma.trade.upsert.mock.calls[0][0].create;
    expect(trade.side).toBe('BUY');
    expect(trade.amount.toString()).toBe('42');
    expect(trade.spreadWad.toString()).toBe('5');
    expect(trade.priceWad.toString()).toBe(((42n * WAD) / 100n).toString());

    expect(prisma.market.update.mock.calls[0][0].data.pot.increment.toString()).toBe('42');

    // Shares are tracked incrementally: the event carries the delta, not the new total.
    const outcome = prisma.outcome.update.mock.calls[0][0];
    expect(outcome.data.currentShares.increment.toString()).toBe('100');

    const pos = prisma.position.upsert.mock.calls[0][0].create;
    expect(pos.shares.toString()).toBe('100');
    // The spread is already inside `cost`, so basis is the cost and nothing is added on top.
    expect(pos.costBasis.toString()).toBe('42');
  });

  it('sell: decrements pot by the proceeds and realizes PnL (positive)', async () => {
    const { processor, prisma } = makeFakes();
    prisma.position.findUnique.mockResolvedValueOnce({
      shares: new Prisma.Decimal('100'),
      costBasis: new Prisma.Decimal('40'),
    });

    await processor.processBatch([
      log({
        kind: 'LS_LMSR',
        eventName: 'Sold',
        args: { marketId: 1n, account: '0xACC', outcomeId: 0n, shares: 50n, proceeds: 30n, spreadWad: 5n },
      }),
    ]);

    // Only the proceeds leave the pot; the spread was withheld and stays behind as surplus.
    expect(prisma.market.update.mock.calls[0][0].data.pot.increment.toString()).toBe('-30');
    expect(prisma.outcome.update.mock.calls[0][0].data.currentShares.increment.toString()).toBe('-50');

    const upd = prisma.position.upsert.mock.calls[0][0].update;
    expect(upd.shares.decrement.toString()).toBe('50');
    expect(upd.costBasis.decrement.toString()).toBe('20'); // 40 * 50/100
    expect(upd.realizedPnl.increment.toString()).toBe('10'); // 30 - 20
  });

  it('short: credits every OTHER outcome, never the one shorted (positive)', async () => {
    // The load-bearing test for shorts. `Shorted` names the outcome the trader bet AGAINST, but
    // the contract credited shares in all the others. Recording them against `outcomeId` would
    // show the trader long exactly the thing they shorted.
    const findUnique = jest.fn(async ({ where }: any) => {
      if (where.address_marketId) return { id: 'm1', address: '0xengine', marketId: 1n };
      return { id: 'm1', address: '0xengine', marketId: 1n, outcomeCount: 3 };
    });
    const { processor, prisma } = makeFakes(findUnique);

    await processor.processBatch([
      log({
        kind: 'LS_LMSR',
        eventName: 'Shorted',
        args: { marketId: 1n, account: '0xACC', outcomeId: 0n, shares: 60n, cost: 45n, spreadWad: 7n },
      }),
    ]);

    const creditedOutcomes = prisma.outcome.update.mock.calls.map(
      (c: any) => c[0].where.marketRef_index.index,
    );
    expect(creditedOutcomes.sort()).toEqual([1, 2]);
    expect(creditedOutcomes).not.toContain(0);

    const positionOutcomes = prisma.position.upsert.mock.calls.map((c: any) => c[0].create.outcomeIndex);
    expect(positionOutcomes.sort()).toEqual([1, 2]);

    // The tape still records the outcome the trader chose, because that is the view they took.
    expect(prisma.trade.upsert.mock.calls[0][0].create.outcomeIndex).toBe(0);
    expect(prisma.trade.upsert.mock.calls[0][0].create.side).toBe('SHORT');
  });

  it('short: splits cost basis across the legs so the parts sum to the cost (regression)', async () => {
    // 100 across 3 legs must not silently lose a unit to integer division.
    const findUnique = jest.fn(async ({ where }: any) => {
      if (where.address_marketId) return { id: 'm1', address: '0xengine', marketId: 1n };
      return { id: 'm1', address: '0xengine', marketId: 1n, outcomeCount: 4 };
    });
    const { processor, prisma } = makeFakes(findUnique);

    await processor.processBatch([
      log({
        kind: 'LS_LMSR',
        eventName: 'Shorted',
        args: { marketId: 1n, account: '0xACC', outcomeId: 3n, shares: 10n, cost: 100n, spreadWad: 0n },
      }),
    ]);

    const bases = prisma.position.upsert.mock.calls.map((c: any) =>
      BigInt(c[0].create.costBasis.toString()),
    );
    expect(bases).toHaveLength(3);
    expect(bases.reduce((a: bigint, b: bigint) => a + b, 0n)).toBe(100n);
  });

  it('resolution: retains exactly what is owed and records the swept surplus (positive)', async () => {
    const { processor, prisma, markets } = makeFakes();
    await processor.processBatch([
      log({
        kind: 'LS_LMSR',
        eventName: 'MarketResolved',
        args: { marketId: 1n, winningOutcomeId: 1n, owed: 500n, surplus: 10n },
      }),
    ]);
    const upd = prisma.market.update.mock.calls[0][0];
    expect(upd.data.status).toBe('RESOLVED');
    expect(upd.data.winningOutcomeId).toBe(1);
    // pot is SET to the liability, not decremented: the contract already swept the rest.
    expect(upd.data.pot.toString()).toBe('500');
    expect(upd.data.surplus.toString()).toBe('10');
    expect(markets.invalidate).toHaveBeenCalledWith('m1');
  });

  it('redeem: marks the position redeemed and draws the payout out of the pot (positive)', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({
        kind: 'LS_LMSR',
        eventName: 'Redeemed',
        args: { marketId: 1n, account: '0xACC', amount: 250n },
      }),
    ]);
    expect(prisma.position.updateMany.mock.calls[0][0].data.redeemed).toBe(true);
    expect(prisma.market.update.mock.calls[0][0].data.pot.decrement.toString()).toBe('250');
  });

  it('seed redemption of zero touches nothing (negative)', async () => {
    // A voided market pays the creator no seed. Writing a zero-decrement would still bump
    // updatedAt and invalidate caches for no reason.
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({
        kind: 'LS_LMSR',
        eventName: 'SeedRedeemed',
        args: { marketId: 1n, creator: '0xCREATOR', amount: 0n },
      }),
    ]);
    expect(prisma.market.update).not.toHaveBeenCalled();
  });

});
