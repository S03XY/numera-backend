import { Prisma } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';
import { MarketSerializer, MarketWithOutcomes } from './market.serializer';

const cfg = { chain: { collateralDecimals: 6 } } as unknown as AppConfigService;

function makeMarket(overrides: Partial<MarketWithOutcomes> = {}): MarketWithOutcomes {
  const base: MarketWithOutcomes = {
    id: 'm1',
    engine: 'LS_LMSR',
    address: '0xengine',
    marketId: 1n,
    collateral: '0xusdc',
    resolver: '0xres',
    startTime: new Date(Date.now() - 3600_000),
    closeTime: new Date(Date.now() + 3600_000),
    outcomeCount: 2,
    categoryKey: 'SPORTS',
    metadataHash: '0x00',
    creator: '0xlp',
    alpha: new Prisma.Decimal('25000000000000000'),
    sStar: new Prisma.Decimal('2000000000000000000000'),
    seed: new Prisma.Decimal('1000000000'),
    surplus: null,
    status: 'TRADING',
    winningOutcomeId: null,
    pot: new Prisma.Decimal('1500000'),
    title: 'Test market',
    description: 'desc',
    resolutionRules: 'Settles per the official match report.',
    imageUrl: null,
    createdBlock: 0n,
    createdTx: '0x00',
    createdAt: new Date(),
    updatedAt: new Date(),
    outcomes: [
      {
        id: 'o2',
        marketRef: 'm1',
        index: 1,
        label: 'No',
        currentPriceWad: new Prisma.Decimal('400000000000000000'),
        currentShares: new Prisma.Decimal('0'),
      },
      {
        id: 'o1',
        marketRef: 'm1',
        index: 0,
        label: 'Yes',
        currentPriceWad: new Prisma.Decimal('600000000000000000'),
        currentShares: new Prisma.Decimal('0'),
      },
    ] as MarketWithOutcomes['outcomes'],
    ...overrides,
  };
  return base;
}

describe('MarketSerializer', () => {
  const serializer = new MarketSerializer(cfg);

  it('serializes a market, formatting amounts and prices', () => {
    const view = serializer.market(makeMarket());
    expect(view.marketId).toBe('1');
    expect(view.pot).toBe('1500000');
    expect(view.potHuman).toBe('1.5');
    expect(view.tradingOpen).toBe(true);
    expect(view.collateralDecimals).toBe(6);
  });

  it('orders outcomes by index and computes probability', () => {
    const view = serializer.market(makeMarket());
    expect(view.outcomes.map((o) => o.index)).toEqual([0, 1]);
    expect(view.outcomes[0].label).toBe('Yes');
    expect(view.outcomes[0].probability).toBe('0.6');
  });

  it('marks tradingOpen false once closeTime has passed', () => {
    const view = serializer.market(makeMarket({ closeTime: new Date(Date.now() - 1000) }));
    expect(view.tradingOpen).toBe(false);
  });

  it('marks tradingOpen false when resolved even before close', () => {
    const view = serializer.market(makeMarket({ status: 'RESOLVED', winningOutcomeId: 0 }));
    expect(view.tradingOpen).toBe(false);
    expect(view.winningOutcomeId).toBe(0);
  });

  /**
   * The engine reverts a trade before `startTime` with `MarketNotOpenYet`. A UI that offered the
   * bet anyway would produce a signed trade that cannot land, and the revert names a condition the
   * trader was never shown — so both ends of the window are reported, and separately.
   */
  it('marks tradingOpen false before startTime, and says why', () => {
    const view = serializer.market(
      makeMarket({
        startTime: new Date(Date.now() + 3600_000),
        closeTime: new Date(Date.now() + 7200_000),
      }),
    );

    expect(view.tradingOpen).toBe(false);
    expect(view.notOpenYet).toBe(true);
  });

  it('distinguishes not-open-yet from closed', () => {
    const closed = serializer.market(
      makeMarket({
        startTime: new Date(Date.now() - 7200_000),
        closeTime: new Date(Date.now() - 1000),
      }),
    );

    expect(closed.tradingOpen).toBe(false);
    // Both are "you cannot bet", and they are not the same sentence to a user.
    expect(closed.notOpenYet).toBe(false);
  });

  it('reports an already-open market as open, with its start time in the past', () => {
    const view = serializer.market(makeMarket());

    expect(view.tradingOpen).toBe(true);
    expect(view.notOpenYet).toBe(false);
    expect(Date.parse(view.startTime)).toBeLessThan(Date.now());
  });
});

/**
 * The resolution view.
 *
 * Two distinctions carry real weight here and neither is obvious from the field names:
 *
 *  - **`disputable` vs `finalizable`** — a proposal whose window has passed is neither settled nor
 *    still challengeable. It is waiting for somebody to send `finalize`. Collapsing the two would
 *    tell a trader their money is claimable while the chain still disagrees.
 *  - **`null` outcome vs missing outcome** — null means "void this market", and it has to survive
 *    the trip intact rather than becoming an index or an absence.
 */
describe('MarketSerializer — resolution', () => {
  const serializer = new MarketSerializer(cfg);

  function withResolution(over: Record<string, unknown> = {}) {
    return makeMarket({
      status: 'TRADING',
      closeTime: new Date(Date.now() - 3600_000),
      resolution: {
        id: 'r1',
        address: '0xengine',
        marketId: 1n,
        marketRef: 'm1',
        phase: 'PROPOSED',
        proposer: '0xaaa',
        proposedOutcome: 1,
        proposerBonded: true,
        proposerBond: new Prisma.Decimal('25000000'),
        disputeDeadline: new Date(Date.now() + 3600_000),
        disputer: null,
        counterOutcome: null,
        disputerBond: new Prisma.Decimal('0'),
        arbitrationDeadline: null,
        route: null,
        settledOutcome: null,
        reward: new Prisma.Decimal('0'),
        forfeited: new Prisma.Decimal('0'),
        loser: null,
        settledAt: null,
        proposedTx: '0xtx',
        settledTx: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...over,
      },
    } as Partial<MarketWithOutcomes>);
  }

  it('reports null for a market that has never been through the layer (positive)', () => {
    expect(serializer.market(makeMarket()).resolution).toBeNull();
  });

  it('reports a live proposal as challengeable but not settleable (positive)', () => {
    const view = serializer.market(withResolution()).resolution!;
    expect(view.phase).toBe('PROPOSED');
    expect(view.disputable).toBe(true);
    expect(view.finalizable).toBe(false);
    expect(view.bonded).toBe(true);
    expect(view.bond).toBe('25000000');
  });

  it('flips to settleable once the window passes, and never to settled (regression)', () => {
    const view = serializer.market(
      withResolution({ disputeDeadline: new Date(Date.now() - 1000) }),
    ).resolution!;

    expect(view.disputable).toBe(false);
    expect(view.finalizable).toBe(true);
    // Still PROPOSED. The chain has not settled anything until somebody sends `finalize`.
    expect(view.phase).toBe('PROPOSED');
  });

  it('carries a void assertion through as null rather than an index (regression)', () => {
    const view = serializer.market(withResolution({ proposedOutcome: null })).resolution!;
    expect(view.proposedOutcome).toBeNull();
  });

  it('offers neither action once the market is settled (negative)', () => {
    const view = serializer.market(
      withResolution({ phase: 'SETTLED', route: 'ARBITRATED', settledOutcome: 1 }),
    ).resolution!;

    expect(view.disputable).toBe(false);
    expect(view.finalizable).toBe(false);
    expect(view.route).toBe('ARBITRATED');
  });

  it('marks an operator proposal as carrying no stake', () => {
    const view = serializer.market(
      withResolution({ proposerBonded: false, proposerBond: new Prisma.Decimal('0') }),
    ).resolution!;

    expect(view.bonded).toBe(false);
  });

  it('counts a closed market with nothing proposed as awaiting one (positive)', () => {
    expect(
      serializer.isAwaitingProposal(
        makeMarket({ status: 'TRADING', closeTime: new Date(Date.now() - 1000) }),
      ),
    ).toBe(true);
  });

  it('does not count a market that already has a live proposal (negative)', () => {
    expect(serializer.isAwaitingProposal(withResolution())).toBe(false);
  });

  it('does not count a market that is still trading (negative)', () => {
    expect(serializer.isAwaitingProposal(makeMarket())).toBe(false);
  });
});
