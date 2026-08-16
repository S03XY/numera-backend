/**
 * Send Monad testnet MON from the deployer to a tester's address.
 *
 * Testers need a small amount of gas for exactly two actions — claiming test
 * collateral, and depositing into the shielded pool. Everything afterwards
 * (every bet, every claim) runs through Unlink's paymaster and needs none.
 *
 * The address to fund is shown on the wallet screen after unlocking, or is just
 * the passkey account address from the header.
 *
 * Usage (from backend/):
 *   PRIVATE_KEY=0x... npx ts-node scripts/fund-tester.ts 0xTester... [amountMon]
 */
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const RPC_URL = process.env.RPC_HTTP_URL || 'https://testnet-rpc.monad.xyz';

/** Comfortably covers a faucet claim plus a deposit, with room for retries. */
const DEFAULT_AMOUNT = '0.2';

const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  testnet: true,
});

async function main() {
  const [to, amountArg] = process.argv.slice(2);
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new Error('Usage: fund-tester.ts <0xAddress> [amountMon]');
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY is required (the funded deployer key).');

  const amount = parseEther(amountArg ?? DEFAULT_AMOUNT);
  const account = privateKeyToAccount(pk as Hex);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(RPC_URL) });
  const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(RPC_URL) });

  /**
   * A plain value transfer, always. Stated explicitly because Monad reserves
   * `gas × maxFeePerGas + value` against the sender's balance up front, and
   * viem's estimate for a bare transfer is padded well above 21000 — enough
   * that a deployer holding several MON is rejected with the obscure
   * "reserve balance violation" rather than an insufficient-funds message.
   */
  const gas = 21_000n;
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas;
  const reserved = amount + gas * maxFeePerGas;

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < reserved) {
    throw new Error(
      `Deployer holds ${formatEther(balance)} MON; sending ${formatEther(amount)} needs ` +
        `${formatEther(reserved)} reserved (value plus max gas).`,
    );
  }

  // Simulate first. Not every address can receive MON: an EIP-7702 delegated
  // EOA runs its delegate's code on a plain transfer, and that code may revert.
  // Discovering this from a reverted transaction costs real gas and reports
  // nothing useful, so refuse up front and name the cause.
  try {
    await publicClient.call({ account: account.address, to: to as Hex, value: amount, gas });
  } catch {
    const code = await publicClient.getCode({ address: to as Hex });
    const delegate =
      code && code.toLowerCase().startsWith('0xef0100') ? `0x${code.slice(8, 48)}` : null;
    throw new Error(
      delegate
        ? `${to} cannot receive MON: it is an EIP-7702 account delegated to ${delegate}, ` +
          `whose code rejects plain transfers. Use a different address.`
        : `${to} rejects plain MON transfers (it is a contract, or its fallback reverts).`,
    );
  }

  const hash = await wallet.sendTransaction({
    to: to as Hex,
    value: amount,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Transfer reverted (tx ${hash})`);

  const now = await publicClient.getBalance({ address: to as Hex });
  console.log(`Sent ${formatEther(amount)} MON to ${to}`);
  console.log(`  tx:      ${hash}`);
  console.log(`  balance: ${formatEther(now)} MON`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
