import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ChainService } from '../chain/chain.service';
import { MarketSerializer, MarketWithOutcomes } from './market.serializer';
import { MarketsService } from './markets.service';
import { ListMarketsDto, MarketSort, SortOrder } from './dto/list-markets.dto';

const cfg = {
  chain: { collateralDecimals: 6, addresses: { optimisticResolver: null } },
} as unknown as AppConfigService;

/** Not ready by default: the terms path is a chain read and has its own tests. */
const chain = {
  isReady: false,
  readResolutionTerms: jest.fn(),
} as unknown as ChainService;

function marketRow(): MarketWithOutcomes {
  return {
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
    pot: new Prisma.Decimal('0'),
    title: 'Test',
    description: '',
    resolutionRules: 'Settles per the official match report.',
    imageUrl: null,
    createdBlock: 0n,
    createdTx: '0x00',
    createdAt: new Date(),
    updatedAt: new Date(),
    outcomes: [],
    resolution: null,
  };
}

function makeService() {
  const prisma = {
    market: {
      findMany: jest.fn(async () => [marketRow()]),
      count: jest.fn(async () => 1),
      findUnique: jest.fn(async () => marketRow()),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;

  const redis = {
    // pass-through cache: always compute
    wrap: jest.fn(async (_k: string, _t: number, f: () => Promise<unknown>) => f()),
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined),
    del: jest.fn(async () => undefined),
    delPattern: jest.fn(async () => undefined),
  } as unknown as RedisService;

  const svc = new MarketsService(prisma, redis, new MarketSerializer(cfg), chain, cfg);
  return { svc, prisma, redis };
}

describe('MarketsService', () => {
  const dto: ListMarketsDto = {
    limit: 25,
    offset: 0,
    sort: MarketSort.CreatedAt,
    order: SortOrder.Desc,
  };

  it('lists markets with total (positive)', async () => {
    const { svc } = makeService();
    const res = await svc.list(dto);
    expect(res.total).toBe(1);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].id).toBe('m1');
  });

  it('applies openOnly filter to the query (positive)', async () => {
    const { svc, prisma } = makeService();
    await svc.list({ ...dto, openOnly: true });
    const call = (prisma.market.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where.status).toBe('TRADING');
    expect(call.where.closeTime).toHaveProperty('gt');
  });

  it('returns a market by id (positive)', async () => {
    const { svc } = makeService();
    const view = await svc.getById('m1');
    expect(view.id).toBe('m1');
  });

  it('throws NotFound for a missing market (negative)', async () => {
    const { svc, prisma } = makeService();
    (prisma.market.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(svc.getById('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('serves detail from cache when present (positive)', async () => {
    const { svc, prisma, redis } = makeService();
    (redis.getJson as jest.Mock).mockResolvedValueOnce({ id: 'cached' });
    const view = await svc.getById('m1');
    expect(view).toEqual({ id: 'cached' });
    expect(prisma.market.findUnique).not.toHaveBeenCalled();
  });
});
