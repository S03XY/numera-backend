/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Database seed: reference data only.
 *
 * This used to insert fabricated markets, trades and positions so the UI had something to render
 * before the chain was wired up. That data is gone deliberately. Every market, price, trade and
 * position now comes from the indexer reading the chain, so a demo row here is indistinguishable
 * in the API from a real one — which means someone browsing the app could be looking at a market
 * that does not exist, and could try to trade it.
 *
 * Categories stay because they are genuine configuration rather than sample content: the engine
 * writes a `category` tag into `MarketCreated`, and the catalog decides which of those are
 * offered. Only SPORTS is enabled at launch; the rest are registered but off, so switching one on
 * later is a config flip rather than a migration.
 *
 * To get markets locally, run the real path — deploy, then `npm run seed:testnet` — and let the
 * indexer populate the database exactly the way production does.
 */
const CATEGORIES = [
  { key: 'SPORTS', label: 'Sports', enabled: true },
  { key: 'ESPORTS', label: 'Esports', enabled: false },
  { key: 'POLITICS', label: 'Politics', enabled: false },
  { key: 'CRYPTO', label: 'Crypto', enabled: false },
  { key: 'ENTERTAINMENT', label: 'Entertainment', enabled: false },
];

async function main(): Promise<void> {
  for (const c of CATEGORIES) {
    await prisma.category.upsert({
      where: { key: c.key },
      create: c,
      update: { label: c.label, enabled: c.enabled },
    });
  }
  const enabled = CATEGORIES.filter((c) => c.enabled).length;
  console.log(`seeded ${CATEGORIES.length} categories (${enabled} enabled)`);
  console.log('no markets seeded by design — deploy, run seed:testnet, and let the indexer fill them');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
