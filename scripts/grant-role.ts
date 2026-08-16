/**
 * Grant a protocol role to an address.
 *
 * The admin console is gated on ON-CHAIN roles read from the contracts, not on
 * any database flag — so an operator testing from the UI signs in with their
 * passkey wallet, and that address needs the role granted to it here.
 *
 * Usage (from backend/):
 *   PRIVATE_KEY=<admin> npx ts-node scripts/grant-role.ts RESOLVER 0xAddress
 *
 * Roles: RESOLVER, MARKET_CREATOR, PAUSER, FEE_MANAGER, CURATOR.
 * The caller must hold DEFAULT_ADMIN_ROLE on the target contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Hex,
} from 'viem';
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

const ACCESS_CONTROL = parseAbi([
  'function grantRole(bytes32 role, address account)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
]);

/**
 * Which contracts each role lives on. A role is meaningless on a contract that
 * does not check it, so granting to the wrong one silently does nothing.
 */
const ROLE_TARGETS: Record<string, Array<'trustedResolver' | 'lmsrMarket' | 'parimutuelMarket'>> = {
  RESOLVER: ['trustedResolver'],
  MARKET_CREATOR: ['lmsrMarket', 'parimutuelMarket'],
  PAUSER: ['lmsrMarket', 'parimutuelMarket'],
  FEE_MANAGER: ['lmsrMarket', 'parimutuelMarket'],
};

async function main() {
  const [roleName, account] = process.argv.slice(2);
  if (!roleName || !ROLE_TARGETS[roleName]) {
    throw new Error(`Usage: grant-role.ts <${Object.keys(ROLE_TARGETS).join('|')}> <0xAddress>`);
  }
  if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account)) {
    throw new Error('A valid 0x address is required.');
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY is required (must hold DEFAULT_ADMIN_ROLE).');

  const book = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'contracts', 'deployments', `${CHAIN_ID}.json`), 'utf8'),
  );

  // Solidity computes these as keccak256("NAME_ROLE"); mirror it exactly.
  const role = keccak256(toBytes(`${roleName}_ROLE`));
  const signer = privateKeyToAccount(pk as Hex);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(RPC_URL) });
  const wallet = createWalletClient({ account: signer, chain: monadTestnet, transport: http(RPC_URL) });

  for (const key of ROLE_TARGETS[roleName]) {
    const address = book[key] as Hex;
    const already = await publicClient.readContract({
      address,
      abi: ACCESS_CONTROL,
      functionName: 'hasRole',
      args: [role, account as Hex],
    });
    if (already) {
      console.log(`${key}: already holds ${roleName}_ROLE`);
      continue;
    }

    const hash = await wallet.writeContract({
      address,
      abi: ACCESS_CONTROL,
      functionName: 'grantRole',
      args: [role, account as Hex],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`grantRole reverted on ${key} (${hash})`);
    console.log(`${key}: granted ${roleName}_ROLE  (tx ${hash})`);
  }

  console.log(`\n${account} can now act as ${roleName} from the UI.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
