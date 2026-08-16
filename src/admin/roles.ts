import { keccak256, toBytes } from 'viem';

/**
 * Canonical protocol roles, mirroring `contracts/src/access/Roles.sol`.
 *
 * Hashes are computed the same way Solidity does (`keccak256("NAME")`) rather
 * than hardcoded, so they can never drift from the contracts.
 */
export const ProtocolRole = {
  /** OpenZeppelin DEFAULT_ADMIN_ROLE is 32 zero bytes, not a hash. */
  DEFAULT_ADMIN: `0x${'00'.repeat(32)}` as `0x${string}`,
  MARKET_CREATOR: keccak256(toBytes('MARKET_CREATOR_ROLE')),
  /** On the optimistic resolver this is the bond-free proposing right, not the last word. */
  RESOLVER: keccak256(toBytes('RESOLVER_ROLE')),
  /** Ruling on a disputed market. Held by the quorum contract, so no wallet holds it directly. */
  ARBITRATOR: keccak256(toBytes('ARBITRATOR_ROLE')),
  /** Barring a market account from trading. */
  BLOCKLIST: keccak256(toBytes('BLOCKLIST_ROLE')),
  PAUSER: keccak256(toBytes('PAUSER_ROLE')),
  FEE_MANAGER: keccak256(toBytes('FEE_MANAGER_ROLE')),
  CURATOR: keccak256(toBytes('CURATOR_ROLE')),
} as const;

export type ProtocolRoleName = keyof typeof ProtocolRole;

/** Which deployed contracts can grant each role (checked in order, any match wins). */
export type RoleContractGroup = 'engines' | 'factory' | 'resolvers' | 'blocklist' | 'all';

export const ROLE_SOURCE: Record<ProtocolRoleName, RoleContractGroup> = {
  DEFAULT_ADMIN: 'all',
  MARKET_CREATOR: 'engines',
  PAUSER: 'engines',
  FEE_MANAGER: 'engines',
  RESOLVER: 'resolvers',
  ARBITRATOR: 'resolvers',
  BLOCKLIST: 'blocklist',
  CURATOR: 'factory',
};
