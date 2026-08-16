/**
 * The shielded pool through the running stack, exactly as the browser drives it.
 *
 * `contracts/script/pool-live.mjs` proves the *chain* works: it talks to the RPC directly, holds
 * the relayer key, and computes its own trees. This proves the *product* works. Everything here
 * goes through the running backend over HTTP with no privileged key at all — the same three
 * endpoints the browser calls, in the same order, with the same client-side crypto.
 *
 * That distinction has teeth. A pool that is perfect on chain and unreachable through the API is
 * indistinguishable, to a user, from one that is broken. The failures this catches — a serialiser
 * that drops a field, an ASP root the backend refuses to republish, a validator that rejects a
 * legitimate proof, a leaf the indexer never mirrored — are all invisible to the chain-level test.
 *
 * Usage (from backend/):
 *   node scripts/pool-integration.mjs
 *
 * Reads `PRIVATE_KEY` from contracts/.env for the one genuinely public step: a wallet putting
 * collateral in. Every later step is unauthenticated and unprivileged, because that is the point.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import * as snarkjs from 'snarkjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ARTIFACTS = join(ROOT, 'frontend', 'public', 'zk');

const F = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_DEPTH = 32;
const UNIT = 1_000_000n;
const API = process.env.API_URL ?? 'http://localhost:3001';

const env = (file) =>
  Object.fromEntries(
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );

const contractsEnv = env('contracts/.env');
const backendEnv = env('backend/.env');
const CHAIN_ID = Number(backendEnv.CHAIN_ID ?? 10143);
const RPC = backendEnv.RPC_HTTP_URL ?? 'https://testnet-rpc.monad.xyz';

const chain = defineChain({
  id: CHAIN_ID,
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const hex = (k) => (k.startsWith('0x') ? k : `0x${k}`);
const depositor = privateKeyToAccount(hex(contractsEnv.PRIVATE_KEY));
// Retries and a generous timeout, because this script polls the public RPC hard while the two
// indexers are also crawling it. A rate-limited read here is not a product failure, and letting one
// abort the run would report a working system as broken.
const transport = http(RPC, { retryCount: 5, retryDelay: 600, timeout: 30_000 });
const publicClient = createPublicClient({ chain, transport });
const asDepositor = createWalletClient({ account: depositor, chain, transport });

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
  'function nonces(address) view returns (uint256)',
]);
const ENTRYPOINT = parseAbi([
  'function deposit(uint256 value, uint256 precommitment) returns (uint256)',
  'function shieldNonces(address owner) view returns (uint256)',
]);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${name}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
};

async function api(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function tx(wallet, params) {
  const hash = await wallet.writeContract(params);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`);
  return receipt;
}

const balanceOf = (token, who) =>
  publicClient.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });

/**
 * Client-side note derivation, mirroring `frontend/src/lib/pool/keys.ts`.
 *
 * Duplicated rather than imported because the frontend is TypeScript compiled by Next, and a copy
 * that has to agree is exactly what these checks are for: if the two ever diverge, this script's
 * note will not be the one the chain minted and the very first assertion fails.
 */
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
const commitmentOf = (n, value, label) => poseidon3([value, label, precommitmentOf(n)]);

/** Wait until the backend's mirror has seen a given block. */
async function waitForLeaves(count) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { body } = await api('/api/pool/state');
    if (body.synced && body.leaves.length >= count) return body;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`the pool index never reached ${count} leaves`);
}

async function main() {
  console.log(`Shielded pool through the running stack at ${API}\n`);

  // ---------------------------------------------------------------- state endpoint
  const initial = await api('/api/pool/state');
  check('the state endpoint answers', initial.status === 200 && initial.body.enabled === true);

  const entrypoint = initial.body.entrypoint;
  const token = initial.body.asset;
  const scope = BigInt(initial.body.scope);

  {
    const state = new LeanIMT((a, b) => poseidon2([a, b]));
    for (const leaf of initial.body.leaves) state.insert(BigInt(leaf.commitment));
    check(
      `the served tree of ${initial.body.leaves.length} leaf/leaves rebuilds the chain's root`,
      state.root === BigInt(initial.body.stateRoot) ||
        (initial.body.leaves.length === 0 && initial.body.stateRoot === '0'),
      `local ${state.root} vs chain ${initial.body.stateRoot}`,
    );
  }

  // A trader, standing in for one unlocked browser session.
  const root = keccak256(toBytes(`numera-integration-${process.pid}-${initial.body.stateRoot}`));
  const keys = masters(root);
  const value = 10n * UNIT;
  const withdrawn = 4n * UNIT;

  // ---------------------------------------------------------------- 1. deposit
  const note = depositNote(keys, 0);
  if ((await balanceOf(token, depositor.address)) < value) {
    await tx(asDepositor, {
      address: token, abi: ERC20, functionName: 'mint', args: [depositor.address, value * 10n],
    });
  }
  await tx(asDepositor, {
    address: token, abi: ERC20, functionName: 'approve', args: [entrypoint, value],
  });
  const depositReceipt = await tx(asDepositor, {
    address: entrypoint,
    abi: ENTRYPOINT,
    functionName: 'deposit',
    args: [value, precommitmentOf(note)],
  });

  const afterDeposit = await waitForLeaves(initial.body.leaves.length + 1);
  check('the indexer mirrored the deposit', afterDeposit.leaves.length > initial.body.leaves.length);

  // The recovery walk: find our own note in a tree that says nothing about who owns what.
  const mine = afterDeposit.leaves.find(
    (l) => l.kind === 'DEPOSIT' && l.precommitment === precommitmentOf(note).toString(),
  );
  check('a client can find its own note by precommitment alone', Boolean(mine));
  check(
    'the note the chain minted is the one the client would compute',
    mine && commitmentOf(note, value, BigInt(mine.label)).toString() === mine.commitment,
  );

  // ---------------------------------------------------------------- 2. fund a market account
  const marketAccount = privateKeyToAccount(
    keccak256(toBytes(`numera-market-account-${depositReceipt.transactionHash}`)),
  );

  const state = new LeanIMT((a, b) => poseidon2([a, b]));
  const asp = new LeanIMT((a, b) => poseidon2([a, b]));
  let aspIndex = -1;
  for (const leaf of afterDeposit.leaves) {
    state.insert(BigInt(leaf.commitment));
    if (leaf.kind === 'DEPOSIT') {
      if (leaf.commitment === mine.commitment) aspIndex = asp.size;
      asp.insert(BigInt(leaf.label));
    }
  }
  check('the rebuilt tree still matches the chain after the deposit',
    state.root === BigInt(afterDeposit.stateRoot));

  const withdrawal = {
    processooor: entrypoint,
    data: encodeAbiParameters([{ type: 'address' }], [marketAccount.address]),
  };
  const context =
    BigInt(
      keccak256(
        encodeAbiParameters(
          [
            {
              type: 'tuple',
              components: [
                { name: 'processooor', type: 'address' },
                { name: 'data', type: 'bytes' },
              ],
            },
            { type: 'uint256' },
          ],
          [withdrawal, scope],
        ),
      ),
    ) % F;

  const statePath = state.generateProof(state.indexOf(BigInt(mine.commitment)));
  const aspPath = asp.generateProof(aspIndex);
  const pad = (s) => [...s, ...Array(MAX_DEPTH - s.length).fill(0n)];
  const change = changeNote(keys, 0, 1);

  const started = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      withdrawnValue: withdrawn,
      stateRoot: state.root,
      stateTreeDepth: statePath.siblings.length,
      ASPRoot: asp.root,
      ASPTreeDepth: aspPath.siblings.length,
      context,
      label: BigInt(mine.label),
      existingValue: value,
      existingNullifier: note.nullifier,
      existingSecret: note.secret,
      newNullifier: change.nullifier,
      newSecret: change.secret,
      stateSiblings: pad(statePath.siblings),
      stateIndex: statePath.index,
      ASPSiblings: pad(aspPath.siblings),
      ASPIndex: aspPath.index,
    },
    join(ARTIFACTS, 'withdraw.wasm'),
    join(ARTIFACTS, 'withdraw.zkey'),
  );
  console.log(`  · proof generated in ${Date.now() - started}ms`);

  const solidityProof = {
    pA: [proof.pi_a[0], proof.pi_a[1]],
    pB: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    pC: [proof.pi_c[0], proof.pi_c[1]],
    pubSignals: publicSignals,
  };
  check('the nullifier hash matches the client formula',
    solidityProof.pubSignals[1] === poseidon1([note.nullifier]).toString());

  // --- negative: a proof against a set the backend never computed must be refused -------------
  const forged = await api('/api/pool/withdraw', {
    withdrawal,
    proof: { ...solidityProof, pubSignals: solidityProof.pubSignals.map((s, i) => (i === 5 ? '12345' : s)) },
  });
  check('an unrecognised association root is refused', forged.status >= 400,
    `got ${forged.status}`);

  // --- negative: a payout must go through the entrypoint, never anywhere else ------------------
  const misrouted = await api('/api/pool/withdraw', {
    withdrawal: { ...withdrawal, processooor: marketAccount.address },
    proof: solidityProof,
  });
  check('a withdrawal processed by anything but the entrypoint is refused',
    misrouted.status >= 400, `got ${misrouted.status}`);

  // --- positive ------------------------------------------------------------------------------
  const before = await balanceOf(token, marketAccount.address);
  const relayed = await api('/api/pool/withdraw', { withdrawal, proof: solidityProof });
  check('the backend relayed a real proof', relayed.status === 200,
    JSON.stringify(relayed.body).slice(0, 160));
  if (relayed.body.hash) {
    await publicClient.waitForTransactionReceipt({ hash: relayed.body.hash });
  }
  check('the market account was funded out of the anonymity set',
    (await balanceOf(token, marketAccount.address)) - before === withdrawn);
  check('the market account holds no gas, and never did',
    (await publicClient.getBalance({ address: marketAccount.address })) === 0n);

  // --- negative: the same proof twice is a double-spend ---------------------------------------
  const replay = await api('/api/pool/withdraw', { withdrawal, proof: solidityProof });
  check('the same proof cannot be submitted twice', replay.status >= 400, `got ${replay.status}`);

  // ---------------------------------------------------------------- 3. return, gaslessly
  /*
    The returned value becomes a *deposit* note at the next index, not a change note.

    Worth being precise about, because it is the one place the two note families meet. Coming back
    from a market account is an ordinary `deposit` as far as the pool is concerned — it emits
    `Deposited` and mints a fresh label — so the note has to be derived the way deposits are, or the
    recovery walk in `notes.ts` will never find it and the money is invisible. `client.ts` takes
    `nextDepositIndex` for exactly this reason; this mirrors it.
  */
  const returned = depositNote(keys, 1);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const typedDomain = {
    name: 'Numera Shielded Pool',
    version: '1',
    chainId: BigInt(CHAIN_ID),
    verifyingContract: entrypoint,
  };
  const shieldTypes = {
    Shield: [
      { name: 'owner', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'precommitment', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const request = {
    owner: marketAccount.address,
    value: withdrawn,
    precommitment: precommitmentOf(returned),
    deadline,
  };
  const shieldNonce = await publicClient.readContract({
    address: entrypoint, abi: ENTRYPOINT, functionName: 'shieldNonces', args: [marketAccount.address],
  });
  const signature = await marketAccount.signTypedData({
    domain: typedDomain,
    types: shieldTypes,
    primaryType: 'Shield',
    message: { ...request, nonce: shieldNonce },
  });

  const permitRaw = await marketAccount.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: BigInt(CHAIN_ID), verifyingContract: token },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: {
      owner: marketAccount.address,
      spender: entrypoint,
      value: withdrawn,
      nonce: await publicClient.readContract({
        address: token, abi: ERC20, functionName: 'nonces', args: [marketAccount.address],
      }),
      deadline,
    },
  });
  const permit = {
    deadline: deadline.toString(),
    v: Number(`0x${permitRaw.slice(130, 132)}`),
    r: `0x${permitRaw.slice(2, 66)}`,
    s: `0x${permitRaw.slice(66, 130)}`,
  };
  const asStrings = {
    owner: request.owner,
    value: request.value.toString(),
    precommitment: request.precommitment.toString(),
    deadline: request.deadline.toString(),
  };

  // --- negative: the note is named in the signature, so it cannot be redirected ---------------
  const hijack = await api('/api/pool/shield', {
    request: { ...asStrings, precommitment: '999999' },
    signature,
    permit,
  });
  check('a tampered precommitment is refused', hijack.status >= 400, `got ${hijack.status}`);

  // --- positive ------------------------------------------------------------------------------
  const shielded = await api('/api/pool/shield', { request: asStrings, signature, permit });
  check('a gasless account returned its balance by signature', shielded.status === 200,
    JSON.stringify(shielded.body).slice(0, 160));
  if (shielded.body.hash) {
    await publicClient.waitForTransactionReceipt({ hash: shielded.body.hash });
  }
  check('the market account is empty again', (await balanceOf(token, marketAccount.address)) === 0n);

  // ---------------------------------------------------------------- the balance, end to end
  const final = await waitForLeaves(afterDeposit.leaves.length + 2);
  const owned = [];
  const spent = new Map(
    final.leaves.filter((l) => l.kind === 'CHANGE').map((l) => [l.spentNullifier, l]),
  );
  for (let i = 0; i < 4; i += 1) {
    const first = depositNote(keys, i);
    const leaf = final.leaves.find(
      (l) => l.kind === 'DEPOSIT' && l.precommitment === precommitmentOf(first).toString(),
    );
    if (!leaf) continue;
    let current = first;
    let held = BigInt(leaf.value);
    for (let j = 1; ; j += 1) {
      const spend = spent.get(poseidon1([current.nullifier]).toString());
      if (!spend) break;
      held -= BigInt(spend.value);
      current = changeNote(keys, i, j);
    }
    if (held > 0n) owned.push(held);
  }
  const total = owned.reduce((a, b) => a + b, 0n);

  check(
    'the whole balance is recoverable from the root secret alone',
    // 10 in, 4 out to the market account, 4 back = 6 in change plus a 4 note. Nothing stored
    // anywhere: this figure is rebuilt from one signature and the pool's public leaves.
    total === value,
    `expected ${value}, recovered ${total} across ${owned.length} note(s)`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nFAILED:', err.shortMessage ?? err.message);
  process.exit(1);
});
