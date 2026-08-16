/**
 * Winning and collecting, through the running stack, with a key nobody had to hold a passkey for.
 *
 * `pool-integration.mjs` proves collateral can cross the shielded pool. This proves the other half
 * of the product: that a bet placed from a derived market account can be resolved, settled and
 * *collected* — the last step, and the one a trader notices most if it is broken.
 *
 * Everything goes through the running backend over HTTP, exactly as the browser does: the bet and
 * the claim are EIP-712 `ForwardRequest`s signed by an account holding no gas and submitted to
 * `/api/relay`, and the proposal goes through the resolution relay. The only privileged thing this
 * script does is what an operator legitimately does — create a market, and briefly shorten the
 * dispute window so the run takes minutes instead of a lunch break.
 *
 * Usage (from backend/):
 *   node scripts/claim-e2e.mjs
 *
 * Restores the dispute window on the way out, including after a failure.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toBytes,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import * as snarkjs from 'snarkjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ARTIFACTS = join(ROOT, 'frontend', 'public', 'zk');
const API = process.env.API_URL ?? 'http://localhost:3001';

const F = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const UNIT = 1_000_000n;
const MAX_DEPTH = 32;

const env = (f) =>
  Object.fromEntries(
    readFileSync(join(ROOT, f), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );

const contractsEnv = env('contracts/.env');
const backendEnv = env('backend/.env');
const CHAIN_ID = Number(backendEnv.CHAIN_ID ?? 10143);
const RPC = backendEnv.RPC_HTTP_URL ?? 'https://testnet-rpc.monad.xyz';
const book = JSON.parse(readFileSync(join(ROOT, 'contracts/deployments/10143.json'), 'utf8'));

const chain = defineChain({
  id: CHAIN_ID,
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const transport = http(RPC, { retryCount: 5, retryDelay: 600, timeout: 30_000 });
const publicClient = createPublicClient({ chain, transport });
const hex = (k) => (k.startsWith('0x') ? k : `0x${k}`);
const admin = privateKeyToAccount(hex(contractsEnv.PRIVATE_KEY));
const asAdmin = createWalletClient({ account: admin, chain, transport });

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${name}`); passed += 1; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
  'function nonces(address) view returns (uint256)',
]);
const ENGINE = parseAbi([
  'function createMarket((address collateral,address resolver,uint64 startTime,uint64 closeTime,uint32 outcomeCount,uint256 alpha,uint256 sStar,uint256 seedPerOutcome,bytes32 category,bytes32 metadataHash,string metadata)) returns (uint256)',
  'function buy(uint256 marketId, uint256 outcomeId, uint256 sharesOut, uint256 maxCost) returns (uint256)',
  'function redeem(uint256 marketId) returns (uint256)',
  'function sharesOf(uint256,address,uint256) view returns (uint256)',
]);
const RESOLVER = parseAbi([
  'function propose(address market, uint256 marketId, uint256 outcomeId) returns (uint256)',
  'function disputeWindow() view returns (uint64)',
  'function setParameters((uint256 bond,uint256 proposalFee,uint64 disputeWindow,uint64 arbitrationTimeout,uint16 rewardBps,uint256 rewardCap) p)',
  'function bond() view returns (uint256)',
  'function proposalFee() view returns (uint256)',
]);
const ENTRYPOINT_ABI = parseAbi([
  'function deposit(uint256 value, uint256 precommitment) returns (uint256)',
]);
const FORWARDER = parseAbi(['function nonces(address) view returns (uint256)']);

const FORWARD_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
  ],
};

async function api(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

async function tx(wallet, params) {
  const hash = await wallet.writeContract(params);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: ${hash}`);
  return r;
}

/** `execution/keys.ts`: HKDF-SHA256 from the root, one independent key per market. */
function marketAccountKey(root, marketRef) {
  const ikm = toBytes(root);
  const salt = new TextEncoder().encode('numera:market-account:v1');
  const info = new TextEncoder().encode(`numera:market-account:v1:${marketRef}`);
  return toHex(hkdf(sha256, ikm, salt, info, 32));
}

/** `lib/pool/keys.ts`. Duplicated so a drift between the two shows up as a failed run. */
const masters = (root) => ({
  nullifier: BigInt(keccak256(toBytes(`${root}:numera:pool:nullifier:v1`))) % F,
  secret: BigInt(keccak256(toBytes(`${root}:numera:pool:secret:v1`))) % F,
});
const depositNote = (m, i) => ({
  nullifier: poseidon2([m.nullifier, BigInt(i)]),
  secret: poseidon2([m.secret, BigInt(i)]),
});
const changeNote = (m, i, j) => ({
  nullifier: poseidon3([m.nullifier, BigInt(i), BigInt(j)]),
  secret: poseidon3([m.secret, BigInt(i), BigInt(j)]),
});
const precommitmentOf = (n) => poseidon2([n.nullifier, n.secret]);

/**
 * An EIP-2612 permit from an account that cannot send `approve`.
 *
 * Bundled with the call that needs it rather than sent alone: a standalone permit relay would let a
 * stranger have us pay for their approvals, so the forwarder only accepts one welded to a request
 * the same account signed.
 */
async function permitFor(account, spender, value, token) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const nonce = await publicClient.readContract({
    address: token, abi: ERC20, functionName: 'nonces', args: [account.address],
  });
  const raw = await account.signTypedData({
    // Version "2": TestUSDC matches Circle's USDC, and a client assuming "1" produces a permit that
    // recovers to a different address and reverts with nothing that explains why.
    domain: { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: token },
    types: { Permit: [
      { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ] },
    primaryType: 'Permit',
    message: { owner: account.address, spender, value, nonce, deadline },
  });
  return {
    owner: account.address, value: value.toString(), deadline: deadline.toString(),
    v: Number(`0x${raw.slice(130, 132)}`), r: `0x${raw.slice(2, 66)}`, s: `0x${raw.slice(66, 130)}`,
  };
}

/** Sign a ForwardRequest the way the browser does, and hand it to the relayer. */
async function relay(account, { to, data, forwarder, domainName, gas = 900_000n, permit }) {
  const nonce = await publicClient.readContract({
    address: forwarder, abi: FORWARDER, functionName: 'nonces', args: [account.address],
  });
  const deadline = Math.floor(Date.now() / 1000) + 900;
  const request = { from: account.address, to, value: 0n, gas, nonce, deadline, data };
  const signature = await account.signTypedData({
    domain: { name: domainName, version: '1', chainId: CHAIN_ID, verifyingContract: forwarder },
    types: FORWARD_TYPES,
    primaryType: 'ForwardRequest',
    message: request,
  });
  const { nonce: _n, ...submitted } = request;
  return api(domainName === 'Numera Forwarder' ? '/api/relay' : '/api/relay/resolution', {
    request: {
      from: submitted.from, to: submitted.to,
      value: submitted.value.toString(), gas: submitted.gas.toString(),
      deadline: submitted.deadline, data: submitted.data, signature,
    },
    ...(permit ? { permit } : {}),
  });
}

let restoreWindow = null;

async function main() {
  console.log(`Resolution and claim, through the running stack at ${API}\n`);

  const engine = book.lsLmsrMarket;
  const token = book.usdc;
  const originalWindow = await publicClient.readContract({
    address: book.optimisticResolver, abi: RESOLVER, functionName: 'disputeWindow',
  });
  const bond = await publicClient.readContract({
    address: book.optimisticResolver, abi: RESOLVER, functionName: 'bond',
  });
  const fee = await publicClient.readContract({
    address: book.optimisticResolver, abi: RESOLVER, functionName: 'proposalFee',
  });

  // 60 seconds, so the run is minutes. Restored in `finally` — a testnet left with a one-minute
  // challenge window is a testnet where nobody can realistically dispute anything.
  const SHORT = 60n;
  await tx(asAdmin, {
    address: book.optimisticResolver, abi: RESOLVER, functionName: 'setParameters',
    args: [{ bond, proposalFee: fee, disputeWindow: SHORT, arbitrationTimeout: 259200n, rewardBps: 200, rewardCap: 50000000n }],
  });
  restoreWindow = originalWindow;
  check('the dispute window was shortened for this run', true, `${originalWindow}s -> ${SHORT}s`);

  // ---------------------------------------------------------------- a market that closes soon
  const now = Math.floor(Date.now() / 1000);
  /*
    Five minutes, not ninety seconds.

    Funding this trader is not instant: a pool deposit has to be mined, the leaf indexer has to
    mirror it, and a Groth16 proof takes a couple of seconds on top. The first version allowed
    ninety seconds for all of that and the book had shut before the bet was signed — which the
    engine correctly refused with `MarketClosed`, and which looked exactly like a broken relay.
  */
  const closeTime = BigInt(now + 300);
  const metadata = JSON.stringify([
    ['title', 'Claim end-to-end probe'], ['description', ''],
    ['resolutionRules', 'Settled by the probe that created it.'], ['imageUrl', null],
    ['outcomeLabels', ['Yes', 'No']], ['categoryKey', null],
  ]);
  const metadataHash = keccak256(toBytes(metadata));
  const seedPerOutcome = 200n * UNIT;

  if ((await publicClient.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [admin.address] })) < 1000n * UNIT) {
    await tx(asAdmin, { address: token, abi: ERC20, functionName: 'mint', args: [admin.address, 5000n * UNIT] });
  }
  await tx(asAdmin, { address: token, abi: ERC20, functionName: 'approve', args: [engine, 5000n * UNIT] });

  const created = await tx(asAdmin, {
    address: engine, abi: ENGINE, functionName: 'createMarket',
    args: [{
      collateral: token, resolver: book.trustedResolver, startTime: 0n, closeTime,
      outcomeCount: 2, alpha: 25000000000000000n, sStar: 2000000000000000000000n,
      seedPerOutcome, category: stringToHex('SPORTS', { size: 32 }), metadataHash, metadata,
    }],
  });
  check('a market was created with a five-minute book', created.status === 'success');

  // Wait for the indexer, and learn the UUID the app derives accounts from.
  let market = null;
  for (let i = 0; i < 60 && !market; i += 1) {
    const { body } = await api('/api/markets?limit=30');
    market = (body.items ?? []).find((m) => m.title === 'Claim end-to-end probe') ?? null;
    if (!market) await sleep(2000);
  }
  if (!market) throw new Error('the indexer never surfaced the probe market');
  check('the indexer adopted the market and its on-chain metadata', market.resolutionRules.length > 0);

  // ---------------------------------------------------------------- a trader
  const root = keccak256(toBytes(`numera-claim-probe-${created.transactionHash}`));
  const trader = privateKeyToAccount(marketAccountKey(root, market.id));
  check('the market account holds no gas, and never will',
    (await publicClient.getBalance({ address: trader.address })) === 0n);

  // Fund it out of the shielded pool, which is the only way it may legitimately be funded.
  const keys = masters(root);
  const note = depositNote(keys, 0);
  const stake = bond + fee + 60n * UNIT;
  await tx(asAdmin, { address: token, abi: ERC20, functionName: 'approve', args: [book.poolEntrypoint, stake] });
  const dep = await tx(asAdmin, {
    address: book.poolEntrypoint, abi: ENTRYPOINT_ABI, functionName: 'deposit',
    args: [stake, precommitmentOf(note)],
  });
  check('collateral entered the shielded pool', dep.status === 'success');

  let state = null;
  for (let i = 0; i < 90; i += 1) {
    const { body } = await api('/api/pool/state');
    if (body.synced && body.leaves.some((l) => l.precommitment === precommitmentOf(note).toString())) { state = body; break; }
    await sleep(1000);
  }
  if (!state) throw new Error('the pool indexer never mirrored the deposit');

  const mine = state.leaves.find((l) => l.precommitment === precommitmentOf(note).toString());
  const stateTree = new LeanIMT((a, b) => poseidon2([a, b]));
  const aspTree = new LeanIMT((a, b) => poseidon2([a, b]));
  let aspIndex = -1;
  for (const l of state.leaves) {
    stateTree.insert(BigInt(l.commitment));
    if (l.kind === 'DEPOSIT') {
      if (l.commitment === mine.commitment) aspIndex = aspTree.size;
      aspTree.insert(BigInt(l.label));
    }
  }
  const withdrawal = {
    processooor: state.entrypoint,
    data: encodeAbiParameters([{ type: 'address' }], [trader.address]),
  };
  const context = BigInt(keccak256(encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'processooor', type: 'address' }, { name: 'data', type: 'bytes' }] }, { type: 'uint256' }],
    [withdrawal, BigInt(state.scope)],
  ))) % F;
  const sp = stateTree.generateProof(stateTree.indexOf(BigInt(mine.commitment)));
  const ap = aspTree.generateProof(aspIndex);
  const pad = (s) => [...s, ...Array(MAX_DEPTH - s.length).fill(0n)];
  const change = changeNote(keys, 0, 1);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve({
    withdrawnValue: stake, stateRoot: stateTree.root, stateTreeDepth: sp.siblings.length,
    ASPRoot: aspTree.root, ASPTreeDepth: ap.siblings.length, context, label: BigInt(mine.label),
    existingValue: stake, existingNullifier: note.nullifier, existingSecret: note.secret,
    newNullifier: change.nullifier, newSecret: change.secret,
    stateSiblings: pad(sp.siblings), stateIndex: sp.index,
    ASPSiblings: pad(ap.siblings), ASPIndex: ap.index,
  }, join(ARTIFACTS, 'withdraw.wasm'), join(ARTIFACTS, 'withdraw.zkey'));

  const relayed = await api('/api/pool/withdraw', {
    withdrawal,
    proof: {
      pA: [proof.pi_a[0], proof.pi_a[1]],
      pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
      pC: [proof.pi_c[0], proof.pi_c[1]],
      pubSignals: publicSignals,
    },
  });
  if (relayed.body.hash) await publicClient.waitForTransactionReceipt({ hash: relayed.body.hash });
  check('the market account was funded privately',
    (await publicClient.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [trader.address] })) === stake);

  // ---------------------------------------------------------------- the bet, relayed
  const shares = 30n * UNIT;
  const bet = await relay(trader, {
    to: engine, forwarder: book.numeraForwarder, domainName: 'Numera Forwarder',
    data: encodeFunctionData({ abi: ENGINE, functionName: 'buy', args: [BigInt(market.marketId), 0n, shares, 40n * UNIT] }),
    permit: await permitFor(trader, engine, 40n * UNIT, token),
  });
  check('a gasless account placed a bet', bet.status === 200, JSON.stringify(bet.body).slice(0, 140));
  if (bet.body.hash) await publicClient.waitForTransactionReceipt({ hash: bet.body.hash });
  const held = await publicClient.readContract({
    address: engine, abi: ENGINE, functionName: 'sharesOf', args: [BigInt(market.marketId), trader.address, 0n],
  });
  check('the shares are held by the market account, not by anyone identifiable', held === shares);

  // ---------------------------------------------------------------- close, propose, settle
  const untilClose = Number(closeTime) * 1000 - Date.now();
  if (untilClose > 0) { console.log(`  · waiting ${Math.ceil(untilClose / 1000)}s for the book to close`); await sleep(untilClose + 3000); }

  const proposed = await relay(trader, {
    to: book.optimisticResolver, forwarder: book.resolutionForwarder,
    domainName: 'Numera Resolution Forwarder',
    // 500_000 on this forwarder, half the trading cap. Asking for more is refused by
    // `verifyRelayable` before any signature work, which reads as "could not be verified".
    gas: 450_000n,
    data: encodeFunctionData({ abi: RESOLVER, functionName: 'propose', args: [engine, BigInt(market.marketId), 0n] }),
    permit: await permitFor(trader, book.optimisticResolver, bond + fee, token),
  });
  check('the outcome was proposed from the same shielded account', proposed.status === 200,
    JSON.stringify(proposed.body).slice(0, 200));
  if (proposed.body.hash) await publicClient.waitForTransactionReceipt({ hash: proposed.body.hash });

  console.log(`  · waiting ${SHORT}s for the challenge window, then the settlement service`);
  let settled = false;
  for (let i = 0; i < 40 && !settled; i += 1) {
    await sleep(5000);
    const { body } = await api(`/api/markets/${market.id}`);
    settled = body.status === 'RESOLVED';
  }
  check('nobody disputed, and the market settled itself', settled);

  // ---------------------------------------------------------------- the part under test
  const before = await publicClient.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [trader.address] });

  let position = null;
  for (let i = 0; i < 30 && !position; i += 1) {
    const { body } = await api('/api/positions/query', { accounts: [trader.address] });
    position = (body ?? []).find((p) => p.marketRef === market.id) ?? null;
    if (!position) await sleep(2000);
  }
  check('the app can see a winning, uncollected position', Boolean(position) && !position.redeemed,
    JSON.stringify(position).slice(0, 160));
  // This is exactly `isClaimable()` in MarketPosition.tsx — the condition that draws the button.
  const claimable = position && !position.redeemed &&
    (position.marketStatus === 'INVALID' ||
      (position.marketStatus === 'RESOLVED' && position.winningOutcomeId === position.outcomeIndex));
  check('the claim button would be drawn for it', Boolean(claimable));

  const claim = await relay(trader, {
    to: engine, forwarder: book.numeraForwarder, domainName: 'Numera Forwarder',
    data: encodeFunctionData({ abi: ENGINE, functionName: 'redeem', args: [BigInt(market.marketId)] }),
  });
  check('the claim was relayed', claim.status === 200, JSON.stringify(claim.body).slice(0, 200));
  if (claim.body.hash) await publicClient.waitForTransactionReceipt({ hash: claim.body.hash });

  const after = await publicClient.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [trader.address] });
  check('the winnings landed in the market account', after - before === shares,
    `expected +${shares}, got +${after - before}`);

  let redeemed = false;
  for (let i = 0; i < 30 && !redeemed; i += 1) {
    await sleep(2000);
    const { body } = await api('/api/positions/query', { accounts: [trader.address] });
    redeemed = (body ?? []).some((p) => p.marketRef === market.id && p.redeemed);
  }
  // The button disappears on this flag, so a claim the indexer never records is a button that
  // never goes away — which is the report that started this.
  check('the position now reads as collected, so the button retires', redeemed);

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((err) => { console.error('\nFAILED:', err.shortMessage ?? err.message); failed += 1; })
  .finally(async () => {
    /*
      Restoring the window is not optional and must not be able to fail quietly.

      This runs against a live testnet other people are using. A run that dies mid-way and leaves a
      sixty-second challenge window has silently removed the only opportunity anyone has to dispute
      a false settlement — and it would stay that way until somebody noticed. So the restore is
      retried, and if it still cannot be done the script says so as loudly as it can rather than
      exiting on the test result.
    */
    if (restoreWindow === null) { process.exit(failed === 0 ? 0 : 1); }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await tx(asAdmin, {
          address: book.optimisticResolver, abi: RESOLVER, functionName: 'setParameters',
          args: [{
            bond: 25_000_000n, proposalFee: 1_000_000n, disputeWindow: restoreWindow,
            arbitrationTimeout: 259_200n, rewardBps: 200, rewardCap: 50_000_000n,
          }],
        });
        const now = await publicClient.readContract({
          address: book.optimisticResolver, abi: RESOLVER, functionName: 'disputeWindow',
        });
        console.log(`  · dispute window restored to ${now}s`);
        process.exit(failed === 0 ? 0 : 1);
      } catch (e) {
        console.error(`  · restore attempt ${attempt + 1} failed: ${e.shortMessage ?? e.message}`);
        await sleep(3000);
      }
    }
    console.error(`\n!! THE DISPUTE WINDOW IS STILL ${'' + restoreWindow === '600' ? 'SHORT' : 'WRONG'} !!`);
    console.error(`   Restore it by hand:\n   cast send ${book.optimisticResolver} \\\n` +
      `     "setParameters((uint256,uint256,uint64,uint64,uint16,uint256))" \\\n` +
      `     "(25000000,1000000,${restoreWindow},259200,200,50000000)" --private-key $PRIVATE_KEY --rpc-url ${RPC}`);
    process.exit(1);
  });
