import { parseAbi } from 'viem';

/**
 * The forwarder surface the relayer uses.
 *
 * `verifyRelayable` is the important one: it re-runs every rule the contract enforces — target,
 * selector, value, gas cap, signature, nonce, deadline — in a single `eth_call`. Checking against
 * the contract rather than against a second copy of the rules in TypeScript is deliberate: two
 * copies drift, and the copy that matters is the one on chain.
 */
export const FORWARDER_ABI = parseAbi([
  'struct ForwardRequestData { address from; address to; uint256 value; uint256 gas; uint48 deadline; bytes data; bytes signature; }',
  'function execute(ForwardRequestData request) payable',
  'function executeWithPermit(address owner, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s, ForwardRequestData request)',
  'function verifyRelayable(ForwardRequestData request) view returns (bool)',
  'function isRelayable(bytes4 selector) view returns (bool)',
  'function market() view returns (address)',
  'function collateral() view returns (address)',
  'function nonces(address owner) view returns (uint256)',
  'function MAX_RELAY_GAS() view returns (uint256)',
]);

/**
 * The five selectors the forwarder will relay, mirroring `NumeraForwarder.isRelayable`.
 *
 * Derived from the signatures rather than pasted as literals, and cross-checked against the
 * contract at boot (see `RelayService.onModuleInit`) so a mismatch is a startup failure rather
 * than every trade failing in production.
 */
export const RELAYABLE_SIGNATURES = [
  'buy(uint256,uint256,uint256,uint256)',
  'buyComplement(uint256,uint256,uint256,uint256)',
  'sell(uint256,uint256,uint256,uint256)',
  'sellComplement(uint256,uint256,uint256,uint256)',
  'redeem(uint256)',
] as const;

/**
 * The resolution forwarder. Same shape as the trading one, one field apart.
 *
 * It has no `market()` — its single frozen destination is a resolver, not an engine — so the boot
 * check reads `resolver()` instead. Everything else, including `verifyRelayable`, is identical,
 * which is why both forwarders can share one relayer and one nonce queue.
 */
export const RESOLUTION_FORWARDER_ABI = parseAbi([
  'struct ForwardRequestData { address from; address to; uint256 value; uint256 gas; uint48 deadline; bytes data; bytes signature; }',
  'function execute(ForwardRequestData request) payable',
  'function executeWithPermit(address owner, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s, ForwardRequestData request)',
  'function verifyRelayable(ForwardRequestData request) view returns (bool)',
  'function isRelayable(bytes4 selector) view returns (bool)',
  'function resolver() view returns (address)',
  'function collateral() view returns (address)',
  'function nonces(address owner) view returns (uint256)',
  'function MAX_RELAY_GAS() view returns (uint256)',
]);

/**
 * The two selectors the resolution forwarder will relay.
 *
 * Both stake a bond in the same transaction, which is what makes this endpoint affordable to leave
 * open: a spammer has to lock collateral worth many times the gas they cost us, and only gets it
 * back by being right. `finalize` is deliberately absent — it pays the recorded proposer whoever
 * calls it, so the caller has nothing to hide and can send it themselves.
 */
export const RESOLUTION_SIGNATURES = [
  'propose(address,uint256,uint256)',
  'dispute(address,uint256,uint256)',
] as const;

/**
 * EIP-2612, for the one approval a market account cannot send itself.
 *
 * `permit` is permissionless — anyone may submit a valid signature — which is what makes it usable
 * by an account holding no gas, and why the relayer restricts the *spender* rather than the caller.
 */
export const PERMIT_ABI = parseAbi([
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);
