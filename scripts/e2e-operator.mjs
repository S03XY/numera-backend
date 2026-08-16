/**
 * The other half of the resolution layer, live: the operator's bond-free path.
 *
 * `e2e-resolution.mjs` proves the contested route — a stranger lies, a stranger catches it, the
 * quorum rules, the liar loses the stake and the right to trade. This proves the quiet route, which
 * is what most settlements will actually be, plus the property that makes it acceptable:
 *
 *   an operator proposal is bond-free, and is NOT final.
 *
 * If that second part ever stops holding, "the operator can settle quickly" silently becomes "the
 * operator decides", and the whole layer is decoration.
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const BOOK = JSON.parse(readFileSync('../contracts/deployments/10143.json', 'utf8'));
const RPC = process.env.RPC_HTTP_URL;
const KEY = process.env.PRIVATE_KEY;
const MARKET_ID = BigInt(process.env.MARKET_ID ?? '0');

const chain = defineChain({
  id: 10143,
  name: 'monad-testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const rpc = createPublicClient({ chain, transport: http(RPC) });
const operator = privateKeyToAccount(KEY.startsWith('0x') ? KEY : `0x${KEY}`);
const wallet = createWalletClient({ account: operator, chain, transport: http(RPC) });

const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const ENGINE = parseAbi([
  'function buy(uint256 marketId, uint256 outcomeId, uint256 sharesOut, uint256 maxCost) returns (uint256)',
  'function closeTimeOf(uint256 marketId) view returns (uint64)',
  'function isSettled(uint256 marketId) view returns (bool)',
  'function getMarket(uint256 marketId) view returns ((address collateral,address resolver,address creator,uint64 createdAt,uint64 closeTime,uint32 outcomeCount,uint256 alpha,uint256 sStar,uint256 seed,bytes32 category,bytes32 metadataHash,uint8 status,uint32 winningOutcomeId,uint256 collateralHeld,uint256 totalShares,bool tradingOpen))',
]);
const RESOLVER = parseAbi([
  'function propose(address market, uint256 marketId, uint256 outcomeId)',
  'function finalize(address market, uint256 marketId)',
  'function bondFor(address market, uint256 marketId) view returns (uint256)',
  'function disputeWindow() view returns (uint64)',
  'function rewardPool() view returns (uint256)',
  'function getProposal(address market, uint256 marketId) view returns ((address proposer,uint64 disputeDeadline,uint8 phase,bool proposerBonded,address disputer,uint64 arbitrationDeadline,uint32 outcome,uint128 proposerBond,uint128 disputerBond,uint32 counterOutcome))',
]);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function send(to, abi, functionName, args) {
  const hash = await wallet.sendTransaction({
    account: operator,
    chain,
    to,
    data: encodeFunctionData({ abi, functionName, args }),
  });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
  return hash;
}

const usd = (v) => `${(Number(v) / 1e6).toFixed(4)} USDC`;

async function main() {
  const engine = BOOK.lsLmsrMarket;
  const resolver = BOOK.optimisticResolver;
  console.log(`\n=== operator path: market ${MARKET_ID} ===\n`);

  await send(BOOK.usdc, ERC20, 'approve', [engine, 2n ** 255n]);
  await send(engine, ENGINE, 'buy', [MARKET_ID, 0n, 100n * 1000000n, 2n ** 200n]);

  const closeTime = await rpc.readContract({ address: engine, abi: ENGINE, functionName: 'closeTimeOf', args: [MARKET_ID] });
  console.log(`· waiting for close (${new Date(Number(closeTime) * 1000).toISOString()})`);
  while (Math.floor(Date.now() / 1000) <= Number(closeTime)) {
    await new Promise((r) => setTimeout(r, 5000));
  }

  const before = await rpc.readContract({ address: BOOK.usdc, abi: ERC20, functionName: 'balanceOf', args: [operator.address] });
  const bond = await rpc.readContract({ address: resolver, abi: RESOLVER, functionName: 'bondFor', args: [engine, MARKET_ID] });
  const poolBefore = await rpc.readContract({ address: resolver, abi: RESOLVER, functionName: 'rewardPool' });

  console.log('· operator proposes, without a bond');
  await send(resolver, RESOLVER, 'propose', [engine, MARKET_ID, 0n]);

  const after = await rpc.readContract({ address: BOOK.usdc, abi: ERC20, functionName: 'balanceOf', args: [operator.address] });
  check('the operator stakes nothing', before === after, `would have been ${usd(bond)}`);

  const p = await rpc.readContract({ address: resolver, abi: RESOLVER, functionName: 'getProposal', args: [engine, MARKET_ID] });
  check('and is recorded as unbonded', p.proposerBonded === false);

  // The property that keeps this honest: the same window opens, for everybody.
  const window = await rpc.readContract({ address: resolver, abi: RESOLVER, functionName: 'disputeWindow' });
  const opened = Number(p.disputeDeadline) - Math.floor(Date.now() / 1000);
  check(
    'the same challenge window opens as for anyone else',
    Math.abs(opened - Number(window)) < 120,
    `${Math.round(opened / 60)} min, configured ${Number(window) / 60} min`,
  );
  check('the market is NOT settled by the proposal alone', (await rpc.readContract({ address: engine, abi: ENGINE, functionName: 'isSettled', args: [MARKET_ID] })) === false);

  // The window here is 6 hours, so waiting it out is not something a test run can do. What is
  // testable now is that `finalize` refuses until it has passed — the guard that makes the window
  // real rather than advisory.
  let refused = false;
  try {
    await rpc.call({
      account: operator.address,
      to: resolver,
      data: encodeFunctionData({ abi: RESOLVER, functionName: 'finalize', args: [engine, MARKET_ID] }),
    });
  } catch (err) {
    refused = /DisputeWindowOpen|revert/i.test(err.shortMessage ?? err.message ?? '');
  }
  check('settlement is refused until the window has passed (negative)', refused);

  const poolAfter = await rpc.readContract({ address: resolver, abi: RESOLVER, functionName: 'rewardPool' });
  check('the reward pool is untouched by a bond-free proposal', poolBefore === poolAfter, usd(poolAfter));

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log(`=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) {
    console.log('failed:', failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nRUN FAILED:', err.shortMessage ?? err.message);
  process.exit(1);
});
