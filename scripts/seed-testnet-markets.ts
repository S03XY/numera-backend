/**
 * Seed a freshly-deployed chain with tradeable markets.
 *
 * Runs the real operator flow rather than a shortcut, so it exercises the same
 * path a curator uses in production:
 *
 *   1. draft the copy off-chain and hash it (`metadataHashOf`)
 *   2. create the market on-chain, committing to that hash
 *   3. the indexer sees `MarketCreated`, matches the hash, and adopts the copy
 *
 * That is why market creation is deliberately NOT in `Deploy.s.sol`: the hash is
 * keccak over a canonical JSON encoding, and rebuilding that in Solidity would
 * duplicate the encoder and drift from it.
 *
 * Usage (from backend/):
 *   PRIVATE_KEY=0x... npm run seed:testnet
 *
 *   # a fresh batch once the previous one has expired
 *   PRIVATE_KEY=0x... npm run seed:testnet -- --label round2 --closes-in 8
 *
 *   # one book closing in 15 minutes, to exercise resolve → claim
 *   PRIVATE_KEY=0x... npm run seed:testnet -- --limit 1 --closes-in 0.25 --label settle
 *
 * Flags: --limit N, --engine LS_LMSR, --closes-in HOURS, --opens-in HOURS, --label TAG.
 *
 * Idempotent: markets whose metadataHash is already recorded are skipped, so a
 * re-run after a partial failure resumes rather than duplicating. Identity is
 * the copy, not the close time — use `--label` when you want new books.
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
const USDC = 1_000_000n; // 6 decimals

const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  testnet: true,
});

const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function mint(address to, uint256 amount)',
]);

const ENGINE = parseAbi([
  'function createMarket((address collateral,address resolver,uint64 startTime,uint64 closeTime,uint32 outcomeCount,uint256 alpha,uint256 sStar,uint256 seedPerOutcome,bytes32 category,bytes32 metadataHash,string metadata)) returns (uint256)',
]);

/**
 * Curve parameters, from the implementation brief.
 *
 * `alpha` is 0.025 for a binary book and `0.035/(n·ln n)` above that, which keeps the vig roughly
 * constant as outcomes are added rather than letting it scale with `n`. `sStar` is the damping
 * scale: it deepens a thin book so a market is tradeable on a small seed, and fades out as the
 * book grows.
 */
const S_STAR = 2000n * 10n ** 18n;

function alphaFor(n: number): bigint {
  if (n === 2) return 25_000_000_000_000_000n; // 0.025e18
  const value = 0.035 / (n * Math.log(n));
  return BigInt(Math.round(value * 1e18));
}

interface AddressBook {
  chainId: number;
  admin: string;
  usdc: string;
  usdcIsTestToken: boolean;
  trustedResolver: string;
  lsLmsrMarket: string;
}

interface SeedMarket {
  engine: 'LS_LMSR';
  title: string;
  description: string;
  /** How the market settles. Committed to `metadataHash`, so it cannot be reworded later. */
  resolutionRules: string;
  outcomeLabels: string[];
  /** Hours from now until the book closes. */
  closesInHours: number;
  /**
   * Hours from now until betting opens. Omit for a market that opens immediately.
   *
   * Passed as `0` when omitted, which the engine reads as "now" and stores as the creation block's
   * timestamp — so every market has a real start time and none of them is null.
   */
  opensInHours?: number;
  /**
   * Shares of EVERY outcome the creator seeds, in whole USDC.
   *
   * This is the entire subsidy and it is bounded: the creator pays `C(q_seed)` and redeems `seed`
   * at resolution, so their loss is `b·ln(n)` whatever wins. At 1,000/outcome on a binary book
   * that is about 69 USDC; at 250 it is about 34, with a wider spread in exchange.
   */
  seedPerOutcome?: number;
}

/**
 * A spread of shapes so testers hit every code path: binary, three-way and
 * four-way, plus a book closing soon enough to resolve during a session.
 *
 * **Every market is LMSR, deliberately.** Numera's product rule is that a
 * trader can always buy, sell and exit before settlement, and a parimutuel pool
 * cannot offer that: a stake is committed until resolution because there is no
 * maker to sell back to and no price until the pool closes. The engine is still
 * deployed and still indexed so anything already staked can be claimed or
 * refunded, but nothing new is created on it.
 *
 * The pooled markets that used to live here were kept as *content* and moved
 * onto LMSR — a four-way "top scorer" book is a genuinely useful shape to test,
 * it just needs an engine you can get out of.
 */
const MARKETS: SeedMarket[] = [
  {
    engine: 'LS_LMSR',
    title: 'Argentina vs France — who wins?',
    description:
      'Resolves to the winner at full time, including extra time and penalties. Void if abandoned.',
    resolutionRules:
      'Settles to the winner of the match, per the official competition match report. Extra time '
      + 'and penalties count: a knockout tie always has a winner. If the match is abandoned, '
      + 'postponed beyond the close time, or awarded without being played, the market is voided.',
    outcomeLabels: ['Argentina', 'France'],
    closesInHours: 72,
    seedPerOutcome: 500,
  },
  {
    engine: 'LS_LMSR',
    title: 'Manchester City vs Arsenal',
    description: 'Match result at full time (90 minutes plus stoppage). Draw is a valid outcome.',
    resolutionRules:
      'Settles on the score after 90 minutes plus stoppage time, per the official Premier League '
      + 'match report. Extra time and penalties do not count. A level score settles Draw. If the '
      + 'match is abandoned or postponed beyond the close time, the market is voided.',
    outcomeLabels: ['Man City', 'Draw', 'Arsenal'],
    closesInHours: 48,
    seedPerOutcome: 500,
  },
  {
    engine: 'LS_LMSR',
    title: 'Will Arsenal win the Premier League title?',
    description: 'Resolves YES if Arsenal finish first in the final league table.',
    resolutionRules:
      'Settles YES if Arsenal are first in the final Premier League table for the season, as '
      + 'published by the Premier League once every fixture has been played. Points deductions '
      + 'applied before that publication count. Any other finishing position settles NO. If the '
      + 'season is abandoned without a published final table, the market is voided.',
    outcomeLabels: ['Yes', 'No'],
    closesInHours: 240,
    seedPerOutcome: 1000,
  },
  {
    engine: 'LS_LMSR',
    title: 'Will Real Madrid beat Barcelona?',
    description: 'Resolves YES if Real Madrid win in 90 minutes plus stoppage. A draw resolves NO.',
    // Two outcomes and a short window on purpose. The second half of the flow —
    // settle, then claim — cannot be exercised until a market closes, and a
    // tester should not have to wait a day to reach it. Binary also makes the
    // payout arithmetic something a human can check by hand.
    resolutionRules:
      'Settles YES only if Real Madrid lead after 90 minutes plus stoppage time, per the official '
      + 'match report. A draw settles NO, as does a Barcelona win. Extra time and penalties do not '
      + 'count. If the match is abandoned or postponed beyond the close time, the market is voided.',
    outcomeLabels: ['Yes', 'No'],
    closesInHours: 1.5,
    seedPerOutcome: 500,
  },
  {
    engine: 'LS_LMSR',
    title: 'Golden Boot — top scorer',
    description:
      'Resolves to the player with the most goals at the end of the competition. ' +
      'Buy or sell any outcome at any time before the book closes.',
    // Four outcomes: the widest book in the set, and the one where price impact
    // and the "sell one leg, keep the rest" flow are most visible.
    resolutionRules:
      'Settles to the listed player with the most goals at the end of the competition, per the '
      + 'official top-scorer standings. Own goals do not count. If the award is shared and more '
      + 'than one listed player is tied at the top, or the top scorer is not among the listed '
      + 'outcomes, the market is voided.',
    outcomeLabels: ['Haaland', 'Mbappé', 'Kane', 'Salah'],
    closesInHours: 120,
    // Deeper than the binaries: the same stake moves a four-way book further,
    // so a shallow `b` here would make every trade look like a whale.
    seedPerOutcome: 800,
  },
  {
    engine: 'LS_LMSR',
    title: 'Which team scores first?',
    description: 'Resolves to the team scoring the opening goal. "No goal" resolves a 0-0 draw.',
    resolutionRules:
      'Settles to the team credited with the opening goal in the official match report. An own '
      + 'goal counts for the team it is credited to. A goalless match settles \'No goal\'. If the '
      + 'match is abandoned before a goal is scored, the market is voided.',
    outcomeLabels: ['Argentina', 'France', 'No goal'],
    // Short on purpose: gives a tester a book that closes within a session so
    // the resolve → claim path can actually be exercised.
    closesInHours: 2,
    seedPerOutcome: 500,
  },
  {
    engine: 'LS_LMSR',
    title: 'Will the transfer window close without a record fee?',
    description:
      'Opens later today. Resolves NO if any completed transfer exceeds the standing record fee '
      + 'before the window shuts.',
    resolutionRules:
      'Settles YES if no completed permanent transfer during this window exceeds the standing '
      + 'world-record fee, as reported by the selling club or the receiving league. Loan deals and '
      + 'add-on clauses that have not been triggered are excluded. Settles NO otherwise.',
    outcomeLabels: ['Yes', 'No'],
    // The one market that is scheduled rather than open, so a tester can see the "Opens" state and
    // confirm the engine actually refuses a bet before the start — it reverts `MarketNotOpenYet`.
    opensInHours: 1,
    closesInHours: 24,
    seedPerOutcome: 500,
  },
];

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Which markets to create, honouring `--limit`, `--closes-in` and `--label`.
 *
 * `--closes-in` matters more than it looks: `resolve()` reverts while
 * `block.timestamp < closeTime`, so a market seeded with the default 72h cannot
 * be settled — and therefore cannot be claimed — for three days. Seeding a single
 * market to exercise the full buy → resolve → claim lifecycle needs a short one.
 *
 * `--label` is what makes re-seeding possible at all. Identity here is the
 * metadata hash, which covers the copy but not the close time, so a plain re-run
 * skips every market as "already on-chain" — leaving a testnet whose books have
 * all expired and no way to get tradeable ones back short of editing this file.
 * A label distinguishes the copy, so `--label round2` yields a genuinely new
 * batch while keeping the old ones intact for settled-market testing.
 */
function selectMarkets(): SeedMarket[] {
  const limit = flag('limit');
  const closesIn = flag('closes-in');
  const opensIn = flag('opens-in');
  const label = flag('label');
  const engine = flag('engine');

  let chosen = MARKETS;
  // Engine filter runs before --limit so "--engine PARIMUTUEL --limit 1" means
  // the first parimutuel market, which is the only reading that is any use.
  if (engine) {
    const wanted = engine.toUpperCase();
    if (wanted === 'PARIMUTUEL') {
      // Fail loudly rather than seeding an empty set: "0 markets created" reads
      // like a bug, and the reason is a product decision worth stating.
      throw new Error(
        'Parimutuel markets are no longer seeded: every Numera market must let a trader ' +
          'buy, sell and exit before settlement, which a pooled stake cannot do. The engine ' +
          'stays deployed so existing stakes can be claimed or refunded.',
      );
    }
    if (wanted !== 'LS_LMSR') throw new Error('--engine must be LS_LMSR');
    chosen = chosen.filter((m) => m.engine === wanted);
  }
  if (limit) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new Error('--limit must be a positive integer');
    chosen = chosen.slice(0, n);
  }
  if (closesIn) {
    const hours = Number(closesIn);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('--closes-in must be > 0 hours');
    chosen = chosen.map((m) => ({ ...m, closesInHours: hours }));
  }
  if (opensIn) {
    const hours = Number(opensIn);
    // Zero is meaningful and means "now", so this is >= rather than > — unlike `--closes-in`,
    // where a window of zero length is a market nobody can ever bet in.
    if (!Number.isFinite(hours) || hours < 0) throw new Error('--opens-in must be >= 0 hours');
    chosen = chosen.map((m) => ({ ...m, opensInHours: hours }));
  }
  if (label) {
    if (!/^[\w -]{1,32}$/.test(label)) {
      throw new Error('--label must be 1-32 chars of letters, digits, spaces, dashes or underscores');
    }
    chosen = chosen.map((m) => ({ ...m, title: `${m.title} [${label}]` }));
  }
  return chosen;
}

function loadAddressBook(): AddressBook {
  const path = join(__dirname, '..', '..', 'contracts', 'deployments', `${CHAIN_ID}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AddressBook;
  } catch {
    throw new Error(
      `No address book at ${path}. Deploy first:\n` +
        `  cd contracts && PRIVATE_KEY=0x... forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast`,
    );
  }
}

/** `bytes32` from a short ASCII tag, matching Solidity's `bytes32("SPORTS")`. */
function toBytes32(text: string): Hex {
  return stringToHex(text, { size: 32 });
}

/** LMSR seeds bounded loss of `b * ln(N)`; approve with headroom for rounding. */
/**
 * What creating a market costs the seeder, in USDC base units.
 *
 * `C(q_seed) = S + b·ln(n)` where `b = α·(nS + √(nS·s*))`. They redeem `S` at resolution, so the
 * loss is the `b·ln(n)` term — but the whole `C` has to be on hand up front, which is what this
 * estimates. Padded 5% so a rounding difference against the contract does not fail the run
 * halfway through with markets already created.
 */
function seedCost(seedPerOutcome: number, outcomeCount: number): bigint {
  const n = outcomeCount;
  const S = seedPerOutcome;
  const alpha = n === 2 ? 0.025 : 0.035 / (n * Math.log(n));
  const s = n * S;
  const b = alpha * (s + Math.sqrt(s * 2000));
  const total = S + b * Math.log(n);
  return BigInt(Math.ceil(total * 1.05)) * USDC;
}

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY is required (the deployer / market-creator key).');

  const book = loadAddressBook();
  const markets = selectMarkets();
  const account = privateKeyToAccount(pk as Hex);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(RPC_URL) });
  const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(RPC_URL) });
  const prisma = new PrismaClient();

  if (markets.length === 0) throw new Error('No markets selected — check --limit / --engine.');

  console.log(`Seeding ${markets.length} market(s) on chain ${CHAIN_ID}`);
  console.log(`  creator:    ${account.address}`);
  console.log(`  collateral: ${book.usdc}`);

  // Creation pulls the seed cost from the creator, so the wallet needs collateral up front.
  const totalSubsidy = markets.reduce(
    (sum, m) => sum + seedCost(m.seedPerOutcome ?? 500, m.outcomeLabels.length),
    0n,
  );

  let balance = await publicClient.readContract({
    address: book.usdc as Hex,
    abi: ERC20,
    functionName: 'balanceOf',
    args: [account.address],
  });

  if (balance < totalSubsidy && book.usdcIsTestToken) {
    // The deployer is TestUSDC's admin, so it can mint what the subsidies need.
    console.log(`Minting ${(totalSubsidy - balance) / USDC} test USDC for LMSR subsidies…`);
    const hash = await wallet.writeContract({
      address: book.usdc as Hex,
      abi: ERC20,
      functionName: 'mint',
      args: [account.address, totalSubsidy - balance],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    balance = totalSubsidy;
  }
  if (balance < totalSubsidy) {
    throw new Error(
      `Creator holds ${balance / USDC} USDC but needs ${totalSubsidy / USDC} for LMSR subsidies.`,
    );
  }

  if (totalSubsidy > 0n) {
    const hash = await wallet.writeContract({
      address: book.usdc as Hex,
      abi: ERC20,
      functionName: 'approve',
      args: [book.lsLmsrMarket as Hex, totalSubsidy],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log('Approved LMSR engine for subsidies.');
  }

  const now = Math.floor(Date.now() / 1000);
  let created = 0;
  let skipped = 0;

  for (const m of markets) {
    const canonical = {
      title: m.title,
      description: m.description,
      resolutionRules: m.resolutionRules,
      imageUrl: null,
      outcomeLabels: m.outcomeLabels,
      categoryKey: 'SPORTS',
    };
    const metadataHash = metadataHashOf(canonical);

    // Step 1: persist the draft. Idempotent on the hash, which IS the identity.
    const existing = await prisma.marketMetadataDraft.findUnique({ where: { metadataHash } });
    if (existing?.marketRef) {
      console.log(`  skip (already on-chain): ${m.title}`);
      skipped++;
      continue;
    }
    await prisma.marketMetadataDraft.upsert({
      where: { metadataHash },
      create: { metadataHash, ...canonical, createdBy: account.address.toLowerCase() },
      update: {},
    });

    // Step 2: create on-chain, committing to the hash the indexer will match.
    // Rounded to whole seconds. `--closes-in` takes hours, and any window that is not a neat
    // fraction of one — ten minutes is 0.1667 — lands on a fractional number of seconds, which
    // `BigInt()` refuses outright. The flag was therefore usable only for quarter hours, and
    // failed with a RangeError rather than anything that named the cause.
    const closeTime = BigInt(now + Math.round(m.closesInHours * 3600));
    // Zero means "open now": the engine substitutes the creation block's timestamp rather than
    // storing a sentinel, so nothing downstream ever has to handle an absent start.
    const startTime = m.opensInHours ? BigInt(now + Math.round(m.opensInHours * 3600)) : 0n;
    const params = {
      collateral: book.usdc as Hex,
      resolver: book.trustedResolver as Hex,
      startTime,
      closeTime,
      outcomeCount: m.outcomeLabels.length,
      category: toBytes32('SPORTS'),
      metadataHash: metadataHash as Hex,
      /*
        The metadata itself, published on chain in the same transaction.

        The engine checks `keccak256(metadata) == metadataHash` before storing either, so these two
        cannot disagree — and it has no function that can supersede them afterwards. That is what
        turns the hash from a claim into a commitment: anyone can re-encode what the API serves and
        check it against this log.

        `canonicalize` must be byte-identical to what `metadataHashOf` hashed, which is why both
        come from the same call above rather than being rebuilt here.
      */
      metadata: canonicalize(canonical),
    };

    const hash = await wallet.writeContract({
      address: book.lsLmsrMarket as Hex,
      abi: ENGINE,
      functionName: 'createMarket',
      args: [
        {
          ...params,
          alpha: alphaFor(m.outcomeLabels.length),
          sStar: S_STAR,
          seedPerOutcome: BigInt(m.seedPerOutcome ?? 500) * USDC,
        },
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`createMarket reverted for "${m.title}" (tx ${hash})`);
    }
    console.log(`  created ${m.engine.padEnd(10)} ${m.title}`);
    created++;
  }

  await prisma.$disconnect();

  console.log(`\nDone: ${created} created, ${skipped} skipped.`);
  console.log('The indexer adopts the copy when it sees each MarketCreated event.');
  console.log('Ensure INDEXER_ENABLED=true and RPC_HTTP_URL are set, then restart the backend.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
