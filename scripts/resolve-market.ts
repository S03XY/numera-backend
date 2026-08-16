/**
 * Operator tool: settle a market so winners can claim.
 *
 * Markets are bound to `TrustedResolver`, which gates settlement behind
 * `RESOLVER_ROLE`. This calls it with the operator's key.
 *
 * Usage (from backend/):
 *   # list markets and their on-chain ids
 *   PRIVATE_KEY=0x... npm run resolve -- --list
 *
 *   # settle a market on a winning outcome
 *   PRIVATE_KEY=0x... npm run resolve -- --market <uuid> --outcome 0
 *
 *   # void a market; everyone refunds their cost basis
 *   PRIVATE_KEY=0x... npm run resolve -- --market <uuid> --invalid
 *
 * Resolution is irreversible on-chain, so the market and the outcome label are
 * printed and confirmed before anything is sent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PrismaClient } from '@prisma/client';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const RPC_URL = process.env.RPC_HTTP_URL || 'https://testnet-rpc.monad.xyz';

const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  testnet: true,
});

const RESOLVER = parseAbi([
  'function resolveMarket(address market, uint256 marketId, uint256 winningOutcomeId)',
  'function invalidateMarket(address market, uint256 marketId)',
]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

function addressBook(): { trustedResolver: string } {
  const path = join(__dirname, '..', '..', 'contracts', 'deployments', `${CHAIN_ID}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const prisma = new PrismaClient();

  if (has('list')) {
    const markets = await prisma.market.findMany({
      include: { outcomes: { orderBy: { index: 'asc' } } },
      orderBy: { closeTime: 'asc' },
    });
    for (const m of markets) {
      const labels = m.outcomes.map((o) => `${o.index}:${o.label || '?'}`).join('  ');
      console.log(
        `${m.id}  ${m.status.padEnd(9)} ${m.engine.padEnd(10)} closes ${m.closeTime.toISOString()}\n` +
          `    ${m.title || '(untitled)'}\n    ${labels}`,
      );
    }
    await prisma.$disconnect();
    return;
  }

  const marketRef = arg('market');
  if (!marketRef) throw new Error('--market <uuid> is required (or --list)');

  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY is required (must hold RESOLVER_ROLE).');

  const market = await prisma.market.findUnique({
    where: { id: marketRef },
    include: { outcomes: { orderBy: { index: 'asc' } } },
  });
  if (!market) throw new Error(`No market ${marketRef}`);
  if (market.status !== 'TRADING') {
    throw new Error(`Market is already ${market.status}; settlement is irreversible.`);
  }

  const invalid = has('invalid');
  const outcome = invalid ? null : Number(arg('outcome'));
  if (!invalid && (outcome === null || Number.isNaN(outcome))) {
    throw new Error('--outcome <index> is required (or --invalid)');
  }
  if (!invalid && !market.outcomes.some((o) => o.index === outcome)) {
    throw new Error(`Outcome ${outcome} is not one of this market's ${market.outcomeCount}.`);
  }

  const label = invalid ? 'VOID (everyone refunds)' : (market.outcomes[outcome!]?.label ?? `#${outcome}`);
  console.log(`\n  Market:  ${market.title}`);
  console.log(`  Engine:  ${market.engine}  (on-chain id ${market.marketId})`);
  console.log(`  Settle:  ${label}\n`);

  // Irreversible on-chain, so make the operator type it out.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('This cannot be undone. Type "yes" to continue: ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('Aborted.');
    await prisma.$disconnect();
    return;
  }

  const account = privateKeyToAccount(pk as Hex);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(RPC_URL) });
  const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(RPC_URL) });
  const { trustedResolver } = addressBook();

  const hash = invalid
    ? await wallet.writeContract({
        address: trustedResolver as Hex,
        abi: RESOLVER,
        functionName: 'invalidateMarket',
        args: [market.address as Hex, market.marketId],
      })
    : await wallet.writeContract({
        address: trustedResolver as Hex,
        abi: RESOLVER,
        functionName: 'resolveMarket',
        args: [market.address as Hex, market.marketId, BigInt(outcome!)],
      });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  await prisma.$disconnect();

  if (receipt.status !== 'success') throw new Error(`Reverted (tx ${hash})`);
  console.log(`\nSettled. tx ${hash}`);
  console.log('The indexer will flip the market status; winners can then claim from Portfolio.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
