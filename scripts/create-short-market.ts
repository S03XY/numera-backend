/**
 * Create one short-lived market on the live deployment, for testing resolution by hand.
 *
 * The seeder in `seed-testnet-markets.ts` takes its close time in whole hours, which is right for
 * the standard board and useless for exercising settlement: you cannot wait three days to find out
 * whether a dispute works. This takes minutes, defaults to ten, and does nothing else differently
 * — same liquidity parameters, same resolver, same two-step metadata commitment — so what it
 * produces is an ordinary market that simply closes soon.
 *
 *   npx tsx scripts/create-short-market.ts               # closes in 10 minutes
 *   npx tsx scripts/create-short-market.ts --minutes 25
 *   npx tsx scripts/create-short-market.ts --minutes 10 --title "..." --outcomes "Yes,No"
 *
 * Needs `PRIVATE_KEY` (the creator, who pays the seed) and `RPC_HTTP_URL`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  stringToHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalize, metadataHashOf } from '../src/admin/metadata-hash';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const RPC_URL = process.env.RPC_HTTP_URL || 'https://testnet-rpc.monad.xyz';
const USDC = 1_000_000n;
const S_STAR = 2000n * 10n ** 18n;
const SEED_PER_OUTCOME = 200;

const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
]);

const ENGINE = parseAbi([
  'function createMarket((address collateral,address resolver,uint64 closeTime,uint32 outcomeCount,uint256 alpha,uint256 sStar,uint256 seedPerOutcome,bytes32 category,bytes32 metadataHash)) returns (uint256)',
  'function marketCount() view returns (uint256)',
]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Matches the board's liquidity curve, so this market prices like every other one. */
function alphaFor(n: number): bigint {
  if (n === 2) return 25_000_000_000_000_000n;
  return BigInt(Math.round((0.035 / (n * Math.log(n))) * 1e18));
}

/**
 * What creation pulls from the creator.
 *
 * The seed itself plus the LMSR subsidy `b·ln(n)`, padded 5% so a rounding difference against the
 * contract does not revert a run that has already written the draft.
 */
function seedCost(seedPerOutcome: number, outcomeCount: number): bigint {
  const n = outcomeCount;
  const alpha = n === 2 ? 0.025 : 0.035 / (n * Math.log(n));
  const s = n * seedPerOutcome;
  const b = alpha * (s + Math.sqrt(s * 2000));
  return BigInt(Math.ceil((seedPerOutcome + b * Math.log(n)) * 1.05)) * USDC;
}

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY is required (the market creator, who pays the seed).');

  const minutes = Number(arg('minutes') ?? 10);
  if (!Number.isFinite(minutes) || minutes < 2) {
    throw new Error('--minutes must be a number and at least 2.');
  }

  const outcomeLabels = (arg('outcomes') ?? 'Yes,No').split(',').map((s) => s.trim());
  const title = arg('title') ?? `Resolution test — closes in ${minutes} minutes`;
  const description =
    arg('description') ??
    'A short-lived market for exercising settlement end to end. Trading closes minutes after ' +
      'creation, at which point anyone may propose the result and anyone may challenge it.';

  // Written like a real one. The rules are inside `metadataHash`, so this is the wording the market
  // is permanently committed to, test market or not.
  const resolutionRules =
    arg('rules') ??
    'This market exists to test settlement and has no real-world subject. It settles to whichever ' +
      'outcome the operator quorum confirms, and may be voided instead. Nothing here should be ' +
      'read as a claim about any event.';

  const book = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'contracts', 'deployments', `${CHAIN_ID}.json`), 'utf8'),
  );

  const account = privateKeyToAccount(pk.startsWith('0x') ? (pk as Hex) : (`0x${pk}` as Hex));
  const rpc = createPublicClient({ chain: monadTestnet, transport: http(RPC_URL) });
  const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(RPC_URL) });
  const prisma = new PrismaClient();

  const cost = seedCost(SEED_PER_OUTCOME, outcomeLabels.length);
  console.log(`Creating a ${minutes} minute market on chain ${CHAIN_ID}`);
  console.log(`  creator:  ${account.address}`);
  console.log(`  outcomes: ${outcomeLabels.join(' / ')}`);
  console.log(`  seed:     ${(Number(cost) / 1e6).toFixed(2)} USDC`);

  // Top up and approve, so a creator who has drifted below the seed cost is not a failed run.
  let balance = (await rpc.readContract({
    address: book.usdc as Hex,
    abi: ERC20,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;

  if (balance < cost) {
    if (!book.usdcIsTestToken) {
      throw new Error(`Creator holds ${balance} but needs ${cost}, and the collateral is not mintable.`);
    }
    const mint = await wallet.writeContract({
      address: book.usdc as Hex,
      abi: ERC20,
      functionName: 'mint',
      args: [account.address, cost * 4n],
    });
    await rpc.waitForTransactionReceipt({ hash: mint });
    balance = cost * 4n;
    console.log('  minted test collateral for the seed');
  }

  const allowance = (await rpc.readContract({
    address: book.usdc as Hex,
    abi: ERC20,
    functionName: 'allowance',
    args: [account.address, book.lsLmsrMarket as Hex],
  })) as bigint;

  if (allowance < cost) {
    const approve = await wallet.writeContract({
      address: book.usdc as Hex,
      abi: ERC20,
      functionName: 'approve',
      args: [book.lsLmsrMarket as Hex, (1n << 256n) - 1n],
    });
    await rpc.waitForTransactionReceipt({ hash: approve });
    console.log('  approved the engine for the seed');
  }

  const canonical = {
    title,
    description,
    resolutionRules,
    imageUrl: null,
    outcomeLabels,
    categoryKey: 'SPORTS',
  };
  const metadataHash = metadataHashOf(canonical);

  // Step one: the draft, keyed by the hash. The indexer adopts it when it sees `MarketCreated`
  // carrying the same hash, which is what binds the words to the market.
  await prisma.marketMetadataDraft.upsert({
    where: { metadataHash },
    create: { metadataHash, ...canonical, createdBy: account.address.toLowerCase() },
    update: {},
  });

  // Step two: on chain, committing to that hash.
  const closeTime = BigInt(Math.floor(Date.now() / 1000) + Math.round(minutes * 60));
  const hash = await wallet.writeContract({
    address: book.lsLmsrMarket as Hex,
    abi: ENGINE,
    functionName: 'createMarket',
    args: [
      {
        collateral: book.usdc as Hex,
        resolver: book.trustedResolver as Hex,
        closeTime,
        outcomeCount: outcomeLabels.length,
        alpha: alphaFor(outcomeLabels.length),
        sStar: S_STAR,
        seedPerOutcome: BigInt(SEED_PER_OUTCOME) * USDC,
        category: stringToHex('SPORTS', { size: 32 }),
        metadataHash: metadataHash as Hex,
      },
    ],
  });

  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`createMarket reverted (tx ${hash})`);

  const marketId = ((await rpc.readContract({
    address: book.lsLmsrMarket as Hex,
    abi: ENGINE,
    functionName: 'marketCount',
  })) as bigint) - 1n;

  console.log(`\n  created marketId ${marketId} in block ${receipt.blockNumber}`);
  console.log(`  tx ${hash}`);

  // The indexer writes the row; until it has, the market does not exist to the UI.
  process.stdout.write('  waiting for the indexer');
  let row: { id: string } | null = null;
  for (let i = 0; i < 40 && !row; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    process.stdout.write('.');
    row = await prisma.market.findFirst({
      where: { address: (book.lsLmsrMarket as string).toLowerCase(), marketId },
      select: { id: true },
    });
  }
  console.log(row ? ' indexed' : ' NOT INDEXED (check the indexer)');

  const closes = new Date(Number(closeTime) * 1000);
  console.log(`\n  closes at ${closes.toISOString()}  (${closes.toLocaleTimeString()} local)`);
  if (row) console.log(`  http://localhost:3000/markets/${row.id}`);
  console.log(`\n  Trading stops the moment it closes, exits included. After that: propose, then`);
  console.log(`  dispute within the window, then the quorum decides.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
