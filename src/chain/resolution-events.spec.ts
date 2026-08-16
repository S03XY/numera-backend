import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PricesService } from '../prices/prices.service';
import { MarketsService } from '../markets/markets.service';
import { ChainService } from './chain.service';
import { EventProcessor, NormalizedLog } from './event-processor.service';

/**
 * Mirroring the resolution layer into the database.
 *
 * The mistake this file exists to catch is a specific one, and it is easy to make: these logs come
 * from the *resolver*, so `log.address` is the resolver and `args.market` is the engine. A handler
 * that keys off `log.address` looks up a market that does not exist, finds nothing, and silently
 * records no resolution at all — with no error anywhere.
 *
 * After that: the void sentinel, which must become `null` rather than 4,294,967,295; and the
 * lifecycle transitions, which have to leave the row describing the *current* proposal rather than
 * a union of every attempt made on that market.
 */

const RESOLVER = '0xResolver';
const ENGINE = '0xengine';
const INVALID_OUTCOME = 4_294_967_295n;
const ZERO = '0x0000000000000000000000000000000000000000';

function log(
  partial: Partial<NormalizedLog> & Pick<NormalizedLog, 'eventName' | 'args'>,
): NormalizedLog {
  return {
    kind: 'OPTIMISTIC_RESOLVER',
    // The resolver's own address, which is deliberately NOT the engine.
    address: RESOLVER,
    blockNumber: 10n,
    txHash: '0xtx',
    logIndex: 0,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    ...partial,
  };
}

function banLog(
  partial: Partial<NormalizedLog> & Pick<NormalizedLog, 'eventName' | 'args'>,
): NormalizedLog {
  return log({ kind: 'TRADING_BLOCKLIST', address: '0xBlocklist', ...partial });
}

interface Fakes {
  prisma: any;
  processor: EventProcessor;
}

function makeFakes(marketExists = true): Fakes {
  const prisma: any = {
    market: {
      findUnique: jest.fn(async () => (marketExists ? { id: 'm1' } : null)),
      update: jest.fn(async () => ({})),
      upsert: jest.fn(async () => ({ id: 'm1' })),
    },
    resolutionProposal: {
      upsert: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(async () => ({ phase: 'PROPOSED', disputeDeadline: null })),
    },
    bannedAccount: {
      upsert: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    outcome: { update: jest.fn(async () => ({})) },
    trade: { upsert: jest.fn(async () => ({})) },
    position: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
    category: { upsert: jest.fn(async () => ({})) },
  };
  const redis = {
    publish: jest.fn(async () => undefined),
    del: jest.fn(async () => undefined),
  } as unknown as RedisService;
  const prices = { recordPoint: jest.fn(async () => undefined) } as unknown as PricesService;
  const markets = { invalidate: jest.fn(async () => undefined) } as unknown as MarketsService;
  const chain = { isReady: false, readPrices: jest.fn() } as unknown as ChainService;
  const processor = new EventProcessor(prisma as PrismaService, redis, prices, markets, chain);
  return { prisma, processor };
}

const proposed = (over: Record<string, unknown> = {}) =>
  log({
    eventName: 'Proposed',
    args: {
      market: ENGINE,
      marketId: 1n,
      proposer: '0xAAA',
      outcome: 1n,
      bond: 25_000_000n,
      fee: 1_000_000n,
      bonded: true,
      disputeDeadline: 1_800_000_000n,
      ...over,
    },
  });

describe('EventProcessor — resolution', () => {
  // -------------------------------------------------------------- proposing

  it('keys the row off the engine, not off the resolver that emitted the log (regression)', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([proposed()]);

    // The lookup, and the row itself, must both name the engine.
    expect(prisma.market.findUnique.mock.calls[0][0].where.address_marketId).toEqual({
      address: ENGINE,
      marketId: 1n,
    });
    const call = prisma.resolutionProposal.upsert.mock.calls[0][0];
    expect(call.where.address_marketId).toEqual({ address: ENGINE, marketId: 1n });
    expect(call.create.address).toBe(ENGINE);
  });

  it('records the proposal with its stake, deadline and proposer (positive)', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([proposed()]);

    const row = prisma.resolutionProposal.upsert.mock.calls[0][0].create;
    expect(row.phase).toBe('PROPOSED');
    expect(row.proposer).toBe('0xaaa');
    expect(row.proposedOutcome).toBe(1);
    expect(row.proposerBonded).toBe(true);
    expect(row.proposerBond.toString()).toBe('25000000');
    expect(row.marketRef).toBe('m1');
    expect(row.proposedTx).toBe('0xtx');
  });

  it('stores the void sentinel as null rather than as an outcome index (regression)', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([proposed({ outcome: INVALID_OUTCOME })]);

    expect(prisma.resolutionProposal.upsert.mock.calls[0][0].create.proposedOutcome).toBeNull();
  });

  it('records an operator proposal as carrying no stake', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([proposed({ bonded: false, bond: 0n, fee: 0n })]);

    const row = prisma.resolutionProposal.upsert.mock.calls[0][0].create;
    expect(row.proposerBonded).toBe(false);
    expect(row.proposerBond.toString()).toBe('0');
  });

  /**
   * A market can be resolved, unwound and proposed on again. If the update carried the old dispute
   * and settlement columns forward, the row would describe a union of every attempt rather than the
   * one that is actually standing.
   */
  it('clears the previous cycle when a fresh proposal arrives (regression)', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([proposed()]);

    const update = prisma.resolutionProposal.upsert.mock.calls[0][0].update;
    expect(update.disputer).toBeNull();
    expect(update.counterOutcome).toBeNull();
    expect(update.route).toBeNull();
    expect(update.settledOutcome).toBeNull();
    expect(update.settledAt).toBeNull();
    expect(update.settledTx).toBeNull();
  });

  /**
   * A resolution can be indexed before the market it is about — separate contracts, separate
   * streams. Dropping it would lose the proposal entirely, so the row is written with a null ref.
   */
  it('records a proposal for a market it has not indexed yet (negative)', async () => {
    const { processor, prisma } = makeFakes(false);
    await processor.processBatch([proposed()]);

    expect(prisma.resolutionProposal.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.resolutionProposal.upsert.mock.calls[0][0].create.marketRef).toBeNull();
  });

  // -------------------------------------------------------------- disputing

  it('records a dispute with its counter-outcome and resets the arbitration clock', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({
        eventName: 'Disputed',
        args: {
          market: ENGINE,
          marketId: 1n,
          disputer: '0xBBB',
          counterOutcome: 0n,
          bond: 25_000_000n,
          fee: 1_000_000n,
          arbitrationDeadline: 1_900_000_000n,
        },
      }),
    ]);

    const data = prisma.resolutionProposal.updateMany.mock.calls[0][0].data;
    expect(data.phase).toBe('DISPUTED');
    expect(data.disputer).toBe('0xbbb');
    expect(data.counterOutcome).toBe(0);
    expect(data.arbitrationDeadline).toEqual(new Date(1_900_000_000_000));
  });

  // ------------------------------------------------------------- settlement

  it('records an unchallenged settlement as finalized', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({
        eventName: 'Finalized',
        args: { market: ENGINE, marketId: 1n, outcome: 1n, proposer: '0xAAA', reward: 4_000_000n },
      }),
    ]);

    const data = prisma.resolutionProposal.updateMany.mock.calls[0][0].data;
    expect(data.phase).toBe('SETTLED');
    expect(data.route).toBe('FINALIZED');
    expect(data.settledOutcome).toBe(1);
    expect(data.reward.toString()).toBe('4000000');
  });

  it('records an arbitrated settlement with the losing account', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({
        eventName: 'Arbitrated',
        args: {
          market: ENGINE,
          marketId: 1n,
          outcome: 0n,
          winner: '0xBBB',
          loser: '0xAAA',
          forfeited: 25_000_000n,
          reward: 4_000_000n,
        },
      }),
    ]);

    const data = prisma.resolutionProposal.updateMany.mock.calls[0][0].data;
    expect(data.route).toBe('ARBITRATED');
    expect(data.loser).toBe('0xaaa');
    expect(data.forfeited.toString()).toBe('25000000');
  });

  /**
   * Overturning a bond-free operator proposal leaves nobody to punish, and the contract says so
   * with the zero address. Storing that literally would show a ban on `0x000…0` in the UI.
   */
  it('treats a zero-address loser as nobody rather than as an account (regression)', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({
        eventName: 'Arbitrated',
        args: {
          market: ENGINE,
          marketId: 1n,
          outcome: 0n,
          winner: ZERO,
          loser: ZERO,
          forfeited: 0n,
          reward: 0n,
        },
      }),
    ]);

    expect(prisma.resolutionProposal.updateMany.mock.calls[0][0].data.loser).toBeNull();
  });

  it('reopens the market when a stuck dispute is unwound', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({ eventName: 'DisputeReset', args: { market: ENGINE, marketId: 1n } }),
    ]);

    const data = prisma.resolutionProposal.updateMany.mock.calls[0][0].data;
    expect(data.phase).toBe('NONE');
    expect(data.proposer).toBeNull();
    expect(data.disputer).toBeNull();
    expect(data.proposerBond.toString()).toBe('0');
  });

  it('reopens the market when a stranded proposal is abandoned', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({
        eventName: 'ProposalAbandoned',
        args: { market: ENGINE, marketId: 1n, proposer: '0xAAA' },
      }),
    ]);

    expect(prisma.resolutionProposal.updateMany.mock.calls[0][0].data.phase).toBe('NONE');
  });

  /** `banned: false` is the case where the ban list refused; the forfeit still happened. */
  it('records a forfeit whether or not the ban landed', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({
        eventName: 'Slashed',
        args: { market: ENGINE, marketId: 1n, account: '0xAAA', amount: 25_000_000n, banned: false },
      }),
    ]);

    const data = prisma.resolutionProposal.updateMany.mock.calls[0][0].data;
    expect(data.loser).toBe('0xaaa');
    expect(data.forfeited.toString()).toBe('25000000');
  });

  // -------------------------------------------------------------- the bans

  it('mirrors a ban with the market that caused it', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      banLog({
        eventName: 'Banned',
        args: { account: '0xAAA', context: ENGINE, marketId: 1n, at: 1_800_000_000n },
      }),
    ]);

    const call = prisma.bannedAccount.upsert.mock.calls[0][0];
    expect(call.where.account).toBe('0xaaa');
    expect(call.create.context).toBe(ENGINE);
    expect(call.create.bannedAt).toEqual(new Date(1_800_000_000_000));
    expect(call.create.liftedAt).toBeNull();
  });

  /** An operator banning directly has no market behind it, and the contract passes zero for both. */
  it('stores no market context for a direct operator ban', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      banLog({
        eventName: 'Banned',
        args: { account: '0xAAA', context: ZERO, marketId: 0n, at: 1_800_000_000n },
      }),
    ]);

    const row = prisma.bannedAccount.upsert.mock.calls[0][0].create;
    expect(row.context).toBeNull();
    expect(row.marketId).toBeNull();
  });

  /** Lifting a ban marks the row rather than deleting it: that it happened is part of the record. */
  it('marks an unban rather than removing the row (regression)', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      banLog({ eventName: 'Unbanned', args: { account: '0xAAA', by: '0xOP' } }),
    ]);

    expect(prisma.bannedAccount.updateMany).toHaveBeenCalledWith({
      where: { account: '0xaaa' },
      data: { liftedAt: new Date('2026-01-01T00:00:00Z'), txHash: '0xtx' },
    });
  });

  // ------------------------------------------------------------- dispatch

  it('ignores an event it has no handler for rather than throwing (negative)', async () => {
    const { processor, prisma } = makeFakes();
    await processor.processBatch([
      log({ eventName: 'ParametersUpdated', args: { market: ENGINE, marketId: 1n } }),
    ]);

    expect(prisma.resolutionProposal.upsert).not.toHaveBeenCalled();
    expect(prisma.resolutionProposal.updateMany).not.toHaveBeenCalled();
  });
});
