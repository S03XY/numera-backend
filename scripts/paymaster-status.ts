/**
 * Is Unlink's gas sponsor able to pay right now?
 *
 * When it is not, every shielded operation fails during ERC-4337 validation with
 * `FailedOp(0, "AA31 paymaster deposit too low")`, and the vendor reports that to us as nothing
 * more than "handleOps transaction 0x… reverted". Trades look rejected when they were never
 * offered, so this is the first thing to check when bets stop landing.
 *
 * Usage (from backend/):
 *   npm run paymaster
 *   PAYMASTER=0x… npm run paymaster        # if the environment's sponsor changes
 *
 * Read-only. Touches no key and sends no transaction.
 */
import { createPublicClient, formatEther, http, parseAbi } from 'viem';

const RPC_URL = process.env.RPC_HTTP_URL || 'https://testnet-rpc.monad.xyz';

/** Canonical ERC-4337 v0.7 EntryPoint — the same address on every chain. */
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;

/**
 * Unlink's sponsor on monad-testnet.
 *
 * Read out of `paymasterAndData` on a real UserOperation rather than from any config we own, so
 * it is worth re-deriving if Unlink rotates it: take any recent `handleOps` transaction, decode
 * the op, and the paymaster is the first 20 bytes of `paymasterAndData`.
 */
const PAYMASTER = (process.env.PAYMASTER ??
  '0x5ad169d29ad62a3b7e06a9b8e00fee4a984407db') as `0x${string}`;

/**
 * Gas the sponsor must be able to reserve for one Numera trade.
 *
 * Measured from a real operation: account verification 300,000 + call 3,350,000 +
 * preVerification 100,000 + paymaster verification 100,000 + paymaster postOp 60,000.
 */
const GAS_PER_OP = 3_910_000n;

/**
 * What Unlink declares as `maxFeePerGas`, regardless of what the chain costs.
 *
 * EntryPoint sizes the required prefund from this rather than from the base fee, so the sponsor
 * must hold five times what an operation actually burns. This single number is why the deposit
 * runs dry — see the comparison printed below.
 */
const DECLARED_GWEI = 500n;

async function main(): Promise<void> {
  const rpc = createPublicClient({ transport: http(RPC_URL) });

  const [deposit, block] = await Promise.all([
    rpc.readContract({
      address: ENTRY_POINT,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [PAYMASTER],
    }),
    rpc.getBlock(),
  ]);

  const baseFee = block.baseFeePerGas ?? 0n;
  const required = GAS_PER_OP * DECLARED_GWEI * 1_000_000_000n;
  const actual = GAS_PER_OP * baseFee;

  console.log(`paymaster        ${PAYMASTER}`);
  console.log(`deposit          ${formatEther(deposit)} MON`);
  console.log(`required per op  ${formatEther(required)} MON`);
  console.log('');
  console.log(
    deposit >= required
      ? `STATUS  OK — roughly ${deposit / required} operation(s) can be in flight at once.`
      : `STATUS  BLOCKED — short by ${formatEther(required - deposit)} MON. ` +
        `Every trade will fail validation until this is topped up.`,
  );
  console.log('');
  console.log(`Monad base fee   ${Number(baseFee) / 1e9} gwei`);
  console.log(`Unlink declares  ${DECLARED_GWEI} gwei`);
  console.log(
    `An operation reserves ${formatEther(required)} MON to burn about ${formatEther(actual)} — ` +
      `the reserve is refunded, but it is locked while the operation is in flight, so the ` +
      `declared price sets how many trades the sponsor can serve at once.`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
