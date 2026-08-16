/**
 * Top up Unlink's gas sponsor so shielded trades can execute.
 *
 * `EntryPoint.depositTo(account)` is payable and permissionless — anyone may add to any
 * paymaster's deposit. That is what makes this possible at all, and also what makes it
 * **one-way**: withdrawal is `withdrawTo`, callable only by the paymaster itself. MON sent here
 * belongs to Unlink and cannot be recovered. It is a testnet unblock, not an operating model —
 * funding the sponsor is the vendor's job, and on mainnet it would be an SLA question.
 *
 * Usage (from backend/):
 *   PRIVATE_KEY=0x… npm run fund:paymaster -- 3
 *   PRIVATE_KEY=0x… PAYMASTER=0x… npm run fund:paymaster -- 3
 *
 * Check the effect with `npm run paymaster`.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseAbi,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC_URL = process.env.RPC_HTTP_URL || 'https://testnet-rpc.monad.xyz';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;
const PAYMASTER = (process.env.PAYMASTER ??
  '0x5ad169d29ad62a3b7e06a9b8e00fee4a984407db') as `0x${string}`;

/** What one Numera operation must be able to reserve. Below this, every trade fails validation. */
const REQUIRED_PER_OP = parseEther('1.955');

/** Left behind for the operator's own transactions — seeding books, resolving them. */
const KEEP_FOR_OPERATOR = parseEther('1');

const ENTRY_POINT_ABI = parseAbi([
  'function depositTo(address account) payable',
  'function balanceOf(address) view returns (uint256)',
]);

const monad = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  testnet: true,
});

async function main(): Promise<void> {
  const key = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) throw new Error('PRIVATE_KEY is required.');

  const amountArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!amountArg) throw new Error('Pass an amount in MON, e.g. `npm run fund:paymaster -- 3`.');
  const amount = parseEther(amountArg);
  if (amount <= 0n) throw new Error('Amount must be positive.');

  const account = privateKeyToAccount(key);
  const rpc = createPublicClient({ chain: monad, transport: http(RPC_URL) });
  const wallet = createWalletClient({ account, chain: monad, transport: http(RPC_URL) });

  const [balance, before] = await Promise.all([
    rpc.getBalance({ address: account.address }),
    rpc.readContract({
      address: ENTRY_POINT,
      abi: ENTRY_POINT_ABI,
      functionName: 'balanceOf',
      args: [PAYMASTER],
    }),
  ]);

  console.log(`from       ${account.address}`);
  console.log(`balance    ${formatEther(balance)} MON`);
  console.log(`paymaster  ${PAYMASTER}`);
  console.log(`deposit    ${formatEther(before)} MON`);
  console.log(`sending    ${formatEther(amount)} MON  (one-way — this becomes Unlink's)\n`);

  // Refused rather than warned: an operator who cannot pay for a resolve has a settled market
  // nobody can claim from, which is worse than a blocked trade.
  if (balance < amount + KEEP_FOR_OPERATOR) {
    throw new Error(
      `Would leave only ${formatEther(balance - amount)} MON for the operator's own ` +
        `transactions; keeping at least ${formatEther(KEEP_FOR_OPERATOR)} MON. Send less.`,
    );
  }

  const hash = await wallet.writeContract({
    address: ENTRY_POINT,
    abi: ENTRY_POINT_ABI,
    functionName: 'depositTo',
    args: [PAYMASTER],
    value: amount,
  });
  console.log(`tx         ${hash}`);
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  console.log(`status     ${receipt.status}`);
  if (receipt.status !== 'success') throw new Error('Deposit reverted.');

  const after = await rpc.readContract({
    address: ENTRY_POINT,
    abi: ENTRY_POINT_ABI,
    functionName: 'balanceOf',
    args: [PAYMASTER],
  });
  console.log(`\ndeposit    ${formatEther(before)} → ${formatEther(after)} MON`);
  console.log(
    after >= REQUIRED_PER_OP
      ? `STATUS     OK — trades can execute again.`
      : `STATUS     still below the ${formatEther(REQUIRED_PER_OP)} MON needed per operation.`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
