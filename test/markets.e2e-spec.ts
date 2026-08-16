import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Engine, Prisma } from '@prisma/client';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Markets (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let marketId: string;
  const address = '0xe2e0000000000000000000000000000000000001';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await prisma.market.deleteMany({ where: { address } });
    await prisma.category.upsert({
      where: { key: 'E2E' },
      create: { key: 'E2E', label: 'E2E Test' },
      update: {},
    });

    const market = await prisma.market.create({
      data: {
        engine: Engine.LS_LMSR,
        address,
        marketId: 1n,
        collateral: '0xusdc',
        resolver: '0xres',
        startTime: new Date(Date.now() - 3600_000),
        closeTime: new Date(Date.now() + 3600_000),
        outcomeCount: 2,
        categoryKey: 'E2E',
        metadataHash: '0x00',
        creator: '0xlp',
        alpha: new Prisma.Decimal('25000000000000000'),
        sStar: new Prisma.Decimal('2000000000000000000000'),
        seed: new Prisma.Decimal('1000000000'),
        pot: new Prisma.Decimal('1000000'),
        title: 'E2E market',
        createdBlock: 0n,
        createdTx: '0x00',
        outcomes: {
          create: [
            { index: 0, label: 'Yes', currentPriceWad: new Prisma.Decimal('600000000000000000') },
            { index: 1, label: 'No', currentPriceWad: new Prisma.Decimal('400000000000000000') },
          ],
        },
      },
    });
    marketId = market.id;
  });

  afterAll(async () => {
    // Clean up BOTH the markets and the category this suite created — a leftover
    // category would otherwise leak into the dev database and change what the
    // category nav renders.
    await prisma.market.deleteMany({ where: { address } });
    await prisma.category.deleteMany({ where: { key: 'E2E' } });
    await app.close();
  });

  it('lists markets (public, no auth)', async () => {
    const res = await request(app.getHttpServer()).get('/api/markets?category=E2E').expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const found = res.body.items.find((m: { id: string }) => m.id === marketId);
    expect(found).toBeDefined();
    expect(found.potHuman).toBe('1');
  });

  it('returns a market detail with ordered outcomes and prices', async () => {
    const res = await request(app.getHttpServer()).get(`/api/markets/${marketId}`).expect(200);
    expect(res.body.title).toBe('E2E market');
    expect(res.body.outcomes).toHaveLength(2);
    expect(res.body.outcomes[0].probability).toBe('0.6');
    expect(res.body.tradingOpen).toBe(true);
  });

  it('lists categories including the seeded one', async () => {
    const res = await request(app.getHttpServer()).get('/api/categories').expect(200);
    expect(res.body.some((c: { key: string }) => c.key === 'E2E')).toBe(true);
  });

  it('returns latest prices for the market', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/markets/${marketId}/prices/latest`)
      .expect(200);
    expect(res.body).toEqual([
      { outcomeIndex: 0, priceWad: '600000000000000000' },
      { outcomeIndex: 1, priceWad: '400000000000000000' },
    ]);
  });

  it('404s for an unknown market id (negative)', async () => {
    await request(app.getHttpServer())
      .get('/api/markets/00000000-0000-4000-8000-000000000000')
      .expect(404);
  });

  it('400s for a non-uuid market id (negative)', async () => {
    await request(app.getHttpServer()).get('/api/markets/not-a-uuid').expect(400);
  });
});
