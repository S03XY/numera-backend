/**
 * Live end-to-end run of the resolution layer, against the deployed contracts on Monad testnet.
 *
 * Everything below is a real transaction. The point is not to re-test the logic — Foundry does that
 * against the same bytecode — but to prove the *seams* hold in the deployment: the roles are wired
 * the way the script claimed, the quorum can actually reach the resolver, the engine actually reads
 * the ban list, and the indexer actually mirrors all of it.
 *
 * The one thing it deliberately does NOT use is the shielded relay path. That is proven in
 * `RelayedResolution.t.sol` with a zero-balance account, and reproducing it here would need the
 * browser SDK. What is tested here is the layer underneath it, with plain EOAs standing in for
 * market accounts.
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
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const BOOK = JSON.parse(readFileSync('../contracts/deployments/10143.json', 'utf8'));
const RPC = process.env.RPC_HTTP_URL;
const DEPLOYER_KEY = process.env.PRIVATE_KEY;
const MARKET_ID = BigInt(process.env.MARKET_ID ?? '0');

const chain = defineChain({
  id: 10143,
  name: 'monad-testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const rpc = createPublicClient({ chain, transport: http(RPC) });
const deployer = privateKeyToAccount(DEPLOYER_KEY.startsWith('0x') ? DEPLOYER_KEY : `0x${DEPLOYER_KEY}`);
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

const ERC20 = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const ENGINE = parseAbi([
  'function buy(uint256 marketId, uint256 outcomeId, uint256 sharesOut, uint256 maxCost) returns (uint256)',
  'function quoteBuy(uint256 marketId, uint256 outcomeId, uint256 sharesOut) view returns (uint256)',
  'function closeTimeOf(uint256 marketId) view returns (uint64)',
  'function collateralOf(uint256 marketId) view returns (uint256)',
  'function feesOf(uint256 marketId) view returns (uint256)',
  'function isSettled(uint256 marketId) view returns (bool)',
  'function getMarket(uint256 marketId) view returns ((address collateral,address resolver,address creator,uint64 createdAt,uint64 closeTime,uint32 outcomeCount,uint256 alpha,uint256 sStar,uint256 seed,bytes32 category,bytes32 metadataHash,uint8 status,uint32 winningOutcomeId,uint256 collateralHeld,uint256 totalShares,bool tradingOpen))',
]);
const RESOLVER = parseAbi([
  'function propose(address market, uint256 marketId, uint256 outcomeId)',
  'function dispute(address market, uint256 marketId, uint256 counterOutcomeId)',
  'function finalize(address market, uint256 marketId)',
  'function arbitrate(address market, uint256 marketId, uint256 trueOutcomeId)',
  'function bond() view returns (uint256)',
  'function rewardFor(address market, uint256 marketId) view returns (uint256)',
  'function proposalFee() view returns (uint256)',
  'function getProposal(address market, uint256 marketId) view returns ((address proposer,uint64 disputeDeadline,uint8 phase,bool proposerBonded,address disputer,uint64 arbitrationDeadline,uint32 outcome,uint128 proposerBond,uint128 disputerBond,uint32 counterOutcome))',
]);
const MULTISIG = parseAbi(['function propose(address target, bytes data) returns (uint256)']);
const BLOCKLIST = parseAbi(['function isBanned(address) view returns (bool)']);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function send(to, abi, functionName, args, account = deployer) {
  const w = account === deployer ? wallet : createWalletClient({ account, chain, transport: http(RPC) });
  const hash = await w.sendTransaction({
    account,
    chain,
    to,
    data: encodeFunctionData({ abi, functionName, args }),
  });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
  return hash;
}

/** Expect a revert. Returns the message so the caller can assert on the reason. */
async function expectRevert(to, abi, functionName, args, account) {
  try {
    await rpc.call({
      account: account.address,
      to,
      data: encodeFunctionData({ abi, functionName, args }),
    });
    return null;
  } catch (err) {
    return err.shortMessage ?? err.message ?? String(err);
  }
}

const usd = (v) => `${(Number(v) / 1e6).toFixed(4)} USDC`;

async function main() {
  const engine = BOOK.lsLmsrMarket;
  const resolver = BOOK.optimisticResolver;

  console.log(`\n=== live resolution run: market ${MARKET_ID} on ${engine} ===\n`);

  // Two throwaway accounts standing in for market accounts. Funded with gas here purely because
  // this script is not going through the relay; in production these hold zero MON, forever.
  const proposer = privateKeyToAccount(generatePrivateKey());
  const disputer = privateKeyToAccount(generatePrivateKey());
  console.log(`proposer ${proposer.address}\ndisputer ${disputer.address}\n`);

  console.log('· funding the two stand-in accounts');
  for (const a of [proposer, disputer]) {
    const h = await wallet.sendTransaction({ account: deployer, chain, to: a.address, value: 500000000000000000n });
    await rpc.waitForTransactionReceipt({ hash: h });
  }
  await send(BOOK.usdc, ERC20, 'mint', [deployer.address, 2000n * 1000000n]);
  for (const a of [proposer, disputer]) {
    await send(BOOK.usdc, ERC20, 'transfer', [a.address, 500n * 1000000n]);
    await send(BOOK.usdc, ERC20, 'approve', [resolver, 2n ** 255n], a);
  }

  // --- generate a pot and some fee revenue, so the bond and reward are non-trivial -----------
  console.log('· trading to build a pot and fee revenue');
  await send(BOOK.usdc, ERC20, 'approve', [engine, 2n ** 255n]);
  await send(engine, ENGINE, 'buy', [MARKET_ID, 0n, 200n * 1000000n, 2n ** 200n]);
  await send(engine, ENGINE, 'buy', [MARKET_ID, 1n, 150n * 1000000n, 2n ** 200n]);

  const pot = await rpc.readContract({ address: engine, abi: ENGINE, functionName: 'collateralOf', args: [MARKET_ID] });
  const fees = await rpc.readContract({ address: engine, abi: ENGINE, functionName: 'feesOf', args: [MARKET_ID] });
  check('the engine records fee revenue per market', fees > 0n, `pot ${usd(pot)}, fees ${usd(fees)}`);

  // --- nothing may be proposed before the market closes ---------------------------------------
  const closeTime = await rpc.readContract({ address: engine, abi: ENGINE, functionName: 'closeTimeOf', args: [MARKET_ID] });
  const early = await expectRevert(resolver, RESOLVER, 'propose', [engine, MARKET_ID, 0n], proposer);
  check('refuses a proposal before the market closes (negative)', early !== null && /MarketNotClosed|revert/i.test(early));

  console.log(`· waiting for close (${new Date(Number(closeTime) * 1000).toISOString()})`);
  while (Math.floor(Date.now() / 1000) <= Number(closeTime)) {
    await new Promise((r) => setTimeout(r, 5000));
  }

  // --- the bond is priced off the pot ----------------------------------------------------------
  const bond = await rpc.readContract({ address: resolver, abi: RESOLVER, functionName: 'bond' });
  const fee = await rpc.readContract({ address: resolver, abi: RESOLVER, functionName: 'proposalFee' });
  const reward = await rpc.readContract({ address: resolver, abi: RESOLVER, functionName: 'rewardFor', args: [engine, MARKET_ID] });
  // Flat, deliberately: a proposer can know the cost before opening the market, and the thing a
  // bond has to outweigh — the liar's position — is shielded and cannot be read off the pot anyway.
  check('the bond is flat, whatever the market holds', bond === 25000000n, `${usd(bond)} on a ${usd(pot)} pot`);
  check('the reward is a share of what the market earned', reward === (fees * 200n) / 10000n, usd(reward));

  // --- a false proposal, and a dispute ---------------------------------------------------------
  const proposerBefore = await rpc.readContract({ address: BOOK.usdc, abi: ERC20, functionName: 'balanceOf', args: [proposer.address] });

  console.log('· proposing outcome 0 (the lie)');
  await send(resolver, RESOLVER, 'propose', [engine, MARKET_ID, 0n], proposer);

  const proposerAfter = await rpc.readContract({ address: BOOK.usdc, abi: ERC20, functionName: 'balanceOf', args: [proposer.address] });
  check('the proposal locks the bond and takes the fee', proposerBefore - proposerAfter === bond + fee, usd(proposerBefore - proposerAfter));

  const second = await expectRevert(resolver, RESOLVER, 'propose', [engine, MARKET_ID, 1n], disputer);
  check('refuses a second proposal on the same market (negative)', second !== null);

  const same = await expectRevert(resolver, RESOLVER, 'dispute', [engine, MARKET_ID, 0n], disputer);
  check('refuses a dispute that re-asserts the proposed outcome (negative)', same !== null);

  const early2 = await expectRevert(resolver, RESOLVER, 'finalize', [engine, MARKET_ID], deployer);
  check('refuses to settle while the challenge window is open (negative)', early2 !== null && /DisputeWindowOpen|revert/i.test(early2));

  console.log('· disputing with outcome 1 (the truth)');
  const disputerBefore = await rpc.readContract({ address: BOOK.usdc, abi: ERC20, functionName: 'balanceOf', args: [disputer.address] });
  await send(resolver, RESOLVER, 'dispute', [engine, MARKET_ID, 1n], disputer);
  const disputerAfterBond = await rpc.readContract({ address: BOOK.usdc, abi: ERC20, functionName: 'balanceOf', args: [disputer.address] });
  check('the dispute matches the proposer stake', disputerBefore - disputerAfterBond === bond + fee, usd(disputerBefore - disputerAfterBond));

  const p = await rpc.readContract({ address: resolver, abi: RESOLVER, functionName: 'getProposal', args: [engine, MARKET_ID] });
  check('the market is recorded as disputed', p.phase === 2, `phase ${p.phase}`);

  // --- the quorum rules ------------------------------------------------------------------------
  console.log('· arbitrating through the multisig');
  const inner = encodeFunctionData({ abi: RESOLVER, functionName: 'arbitrate', args: [engine, MARKET_ID, 1n] });
  await send(BOOK.resolverMultisig, MULTISIG, 'propose', [resolver, inner]);

  const settled = await rpc.readContract({ address: engine, abi: ENGINE, functionName: 'isSettled', args: [MARKET_ID] });
  const view = await rpc.readContract({ address: engine, abi: ENGINE, functionName: 'getMarket', args: [MARKET_ID] });
  check('the quorum settled the market on the engine', settled === true);
  check('to the outcome the disputer named', view.winningOutcomeId === 1, `outcome ${view.winningOutcomeId}`);

  const proposerFinal = await rpc.readContract({ address: BOOK.usdc, abi: ERC20, functionName: 'balanceOf', args: [proposer.address] });
  const disputerFinal = await rpc.readContract({ address: BOOK.usdc, abi: ERC20, functionName: 'balanceOf', args: [disputer.address] });
  check('the liar forfeits the whole stake', proposerFinal === proposerAfter, usd(proposerFinal));
  check('the watcher takes the stake back plus the reward', disputerFinal === disputerAfterBond + bond + reward, `+${usd(disputerFinal - disputerAfterBond)}`);

  // --- the ban -------------------------------------------------------------------------------
  const bannedLiar = await rpc.readContract({ address: BOOK.tradingBlocklist, abi: BLOCKLIST, functionName: 'isBanned', args: [proposer.address] });
  const bannedWatcher = await rpc.readContract({ address: BOOK.tradingBlocklist, abi: BLOCKLIST, functionName: 'isBanned', args: [disputer.address] });
  check('the liar is barred from trading', bannedLiar === true);
  check('the watcher is untouched (negative)', bannedWatcher === false);

  // The ban has to bite on the engine, not merely be recorded on the list.
  const banned = await expectRevert(engine, ENGINE, 'buy', [MARKET_ID, 0n, 1000000n, 2n ** 200n], proposer);
  check('the engine refuses a trade from the barred account', banned !== null && /AccountBanned|revert/i.test(banned));

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
