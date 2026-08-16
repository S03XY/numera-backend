import { parseAbi } from 'viem';

/**
 * The shielded pool's contract surface, narrowed to what the backend touches.
 *
 * Written as human-readable signatures rather than imported from the Foundry artifacts, for the
 * same reason the rest of `chain/abis.ts` is: an artifact is 400KB of bytecode and metadata to get
 * four function shapes, and it drifts silently when someone rebuilds without redeploying. These are
 * pinned by `pool.abi.spec.ts` against the deployed selectors.
 */

/** `PrivacyPool` — the leaves live here, and this is the only address the indexer watches. */
export const PRIVACY_POOL_EVENTS = parseAbi([
  'event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)',
  'event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)',
]);

export const PRIVACY_POOL_ABI = parseAbi([
  'function SCOPE() view returns (uint256)',
  'function currentRoot() view returns (uint256)',
  'function currentTreeSize() view returns (uint256)',
  'function nullifierHashes(uint256) view returns (bool)',
]);

/** `NumeraPoolEntrypoint` — the only address anything is ever sent to. */
export const POOL_ENTRYPOINT_ABI = parseAbi([
  'function latestRoot() view returns (uint256)',
  'function rootIndex() view returns (uint256)',
  'function scope() view returns (uint256)',
  'function shieldNonces(address owner) view returns (uint256)',
  'function updateRoot(uint256 root) returns (uint256 index)',
  'function relay((address processooor, bytes data) withdrawal, (uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[8] pubSignals) proof)',
  'function depositFor((address owner, uint256 value, uint256 precommitment, uint256 deadline) req, bytes signature) returns (uint256)',
  'function depositForWithPermit((address owner, uint256 value, uint256 precommitment, uint256 deadline) req, bytes signature, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) returns (uint256)',
]);

/**
 * Where each public signal sits in the flat `pubSignals` array.
 *
 * The circuit emits eight numbers in a fixed order and Solidity reads them by index, so a client
 * that gets the order wrong produces a proof that verifies against the wrong claim. Named here so
 * the backend's validation and the frontend's witness construction cannot drift apart silently.
 */
export const PUB_SIGNAL = {
  newCommitmentHash: 0,
  existingNullifierHash: 1,
  withdrawnValue: 2,
  stateRoot: 3,
  stateTreeDepth: 4,
  aspRoot: 5,
  aspTreeDepth: 6,
  context: 7,
} as const;
