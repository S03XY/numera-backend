import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PositionsService } from './positions.service';

const WAD = 10n ** 18n;

function position(overrides: any = {}) {
  return {
    id: 'p1',
    marketRef: 'm1',
    account: '0x1111111111111111111111111111111111111111',
    outcomeIndex: 0,
    shares: new Prisma.Decimal('100'),
    costBasis: new Prisma.Decimal('40'),
    realizedPnl: new Prisma.Decimal('0'),
    redeemed: false,
    updatedAt: new Date(),
    market: {
      id: 'm1',
      engine: 'LMSR',
      status: 'TRADING',
      title: 'Test',
      // On-chain coordinates the client needs to build a claim call.
      address: '0xengine',
      marketId: 7n,
      collateral: '0xusdc',
      winningOutcomeId: null,
      outcomes: [
        { index: 0, label: 'Yes', currentPriceWad: new Prisma.Decimal((WAD / 2n).toString()) },
        { index: 1, label: 'No', currentPriceWad: new Prisma.Decimal((WAD / 2n).toString()) },
      ],
    },
    ...overrides,
  };
}

function makeService(rows: any[]) {
  const prisma = {
    position: { findMany: jest.fn(async () => rows) },
  } as unknown as PrismaService;
  return new PositionsService(prisma);
}

describe('PositionsService mark-to-market', () => {
  it('marks an open LMSR position at the live price (positive)', async () => {
    const svc = makeService([position()]);
    const [p] = await svc.forAccounts(['0x1111111111111111111111111111111111111111']);
    // 100 shares * 0.5 price = 50
    expect(p.markToMarket).toBe('50');
    expect(p.outcomeLabel).toBe('Yes');
  });

  it('values a resolved winning LMSR position 1:1 (positive)', async () => {
    const svc = makeService([
      position({ market: { ...position().market, status: 'RESOLVED', winningOutcomeId: 0 } }),
    ]);
    const [p] = await svc.forAccounts(['0x1111111111111111111111111111111111111111']);
    expect(p.markToMarket).toBe('100');
  });

  it('values a resolved losing LMSR position at 0 (negative outcome)', async () => {
    const svc = makeService([
      position({ market: { ...position().market, status: 'RESOLVED', winningOutcomeId: 1 } }),
    ]);
    const [p] = await svc.forAccounts(['0x1111111111111111111111111111111111111111']);
    expect(p.markToMarket).toBe('0');
  });

  it('refunds cost basis for an invalid market', async () => {
    const svc = makeService([
      position({ market: { ...position().market, status: 'INVALID' } }),
    ]);
    const [p] = await svc.forAccounts(['0x1111111111111111111111111111111111111111']);
    expect(p.markToMarket).toBe('40');
  });

  it('deduplicates and lowercases queried accounts', async () => {
    const prisma = {
      position: { findMany: jest.fn(async () => []) },
    } as unknown as PrismaService;
    const svc = new PositionsService(prisma);
    await svc.forAccounts([
      '0xAAAA111111111111111111111111111111111111',
      '0xaaaa111111111111111111111111111111111111',
    ]);
    const arg = (prisma.position.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where.account.in).toEqual(['0xaaaa111111111111111111111111111111111111']);
  });
});

/**
 * Parimutuel settlement. Previously this returned `null` for every resolved
 * position, which rendered as "—" on the claim screen instead of the amount won.
 */
function pariPosition(overrides: any = {}) {
  // `market` is merged field-by-field; spreading `overrides` wholesale would
  // replace the whole market object and drop pot/feeBps/outcomes.
  const { market: marketOverrides, ...rest } = overrides;
  return position({
    // Parimutuel positions carry the stake in `shares`.
    shares: new Prisma.Decimal('1000000000'), // 1,000 USDC
    costBasis: new Prisma.Decimal('1000000000'),
    market: {
      id: 'm1',
      engine: 'PARIMUTUEL',
      status: 'RESOLVED',
      title: 'Test',
      address: '0xengine',
      marketId: 7n,
      collateral: '0xusdc',
      winningOutcomeId: 0,
      pot: new Prisma.Decimal('4000000000'), // 4,000 USDC gross
      feeBps: 200,
      outcomes: [
        {
          index: 0,
          label: 'Yes',
          currentPriceWad: new Prisma.Decimal('0'),
          poolAmount: new Prisma.Decimal('1000000000'),
        },
        {
          index: 1,
          label: 'No',
          currentPriceWad: new Prisma.Decimal('0'),
          poolAmount: new Prisma.Decimal('3000000000'),
        },
      ],
      ...marketOverrides,
    },
    ...rest,
  });
}

describe('PositionsService account handling', () => {
  it('deduplicates and lowercases queried accounts', async () => {
    const prisma = {
      position: { findMany: jest.fn(async () => []) },
    } as unknown as PrismaService;
    const svc = new PositionsService(prisma);
    await svc.forAccounts([
      '0xAAAA111111111111111111111111111111111111',
      '0xaaaa111111111111111111111111111111111111',
    ]);
    const arg = (prisma.position.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where.account.in).toEqual(['0xaaaa111111111111111111111111111111111111']);
  });
});
