import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon2 } from 'poseidon-lite';
import { PoolLeafKind } from '@prisma/client';

/**
 * The two Merkle trees the shielded pool runs on, and the rules that keep them honest.
 *
 * ## Why there are two, and why their indices are not interchangeable
 *
 * The **state tree** holds every commitment the pool has ever inserted — deposits and the change
 * notes that withdrawals mint. It is what a proof proves membership of.
 *
 * The **association-set tree** holds *labels*, and only deposits have one. It is the compliance
 * gate: a withdrawal must show its note descends from a deposit the set approves.
 *
 * They therefore contain different numbers of leaves the moment anybody withdraws, and a note's
 * position in one says nothing about its position in the other. Conflating the two indices is the
 * mistake that costs a day: the proof is generated happily, the pairing check passes, and the
 * contract rejects it with a revert that names neither tree.
 *
 * ## Order is the contract
 *
 * `LeanIMT` is append-only. A tree built from the same leaves in a different order has a different
 * root, so every function here takes leaves that are *already* in chain order — block, then log
 * index within the block — and none of them sorts. Sorting here would hide the bug rather than
 * prevent it; `PoolIndexerService` sorts once, at the point where the ordering is known to be true.
 */

/** The hash the pool's `InternalLeanIMT` uses. Anything else produces a root nothing accepts. */
const hash = (a: bigint, b: bigint): bigint => poseidon2([a, b]);

/** A leaf as the rest of the module passes it around: chain order, decimal strings. */
export interface PoolLeafRow {
  kind: PoolLeafKind;
  commitment: string;
  label: string | null;
}

/** The state tree, over every commitment in insertion order. */
export function buildStateTree(leaves: readonly PoolLeafRow[]): LeanIMT {
  const tree = new LeanIMT(hash);
  for (const leaf of leaves) tree.insert(BigInt(leaf.commitment));
  return tree;
}

/**
 * The association-set tree, over deposit labels only.
 *
 * On this deployment the set approves every deposit, so the tree is simply "all labels so far".
 * That is a policy choice and not a structural one: narrowing it later means filtering this input,
 * and nothing else in the system changes.
 */
export function buildAspTree(leaves: readonly PoolLeafRow[]): LeanIMT {
  const tree = new LeanIMT(hash);
  for (const leaf of leaves) {
    if (leaf.kind === PoolLeafKind.DEPOSIT && leaf.label !== null) tree.insert(BigInt(leaf.label));
  }
  return tree;
}

/**
 * Every ASP root this set has passed through, oldest first, capped at the most recent `depth`.
 *
 * ## Why a history rather than just the current root
 *
 * A withdrawal proof pins the ASP root it was built against, and the pool insists that root equals
 * `latestRoot` at the moment the transaction executes. Between a browser fetching state and its
 * proof landing there is a proving delay — seconds at best, and long enough on a phone that a
 * deposit by somebody else will sometimes arrive in the gap.
 *
 * With only the current root, that trader's proof is dead and they must prove again, on a set that
 * may move again. On a busy pool that is not a retry, it is a livelock, and it fails in exactly the
 * conditions that matter: when the pool is popular.
 *
 * Accepting a recent historical root fixes it, and costs nothing in soundness. Every root in this
 * list is one we computed from deposits we indexed, so an attacker cannot name a set of their own;
 * and an older set is a strictly *smaller* one, so nothing is approved that was not approved then.
 */
export function aspRootHistory(leaves: readonly PoolLeafRow[], depth = 32): bigint[] {
  const tree = new LeanIMT(hash);
  const roots: bigint[] = [];
  for (const leaf of leaves) {
    if (leaf.kind !== PoolLeafKind.DEPOSIT || leaf.label === null) continue;
    tree.insert(BigInt(leaf.label));
    roots.push(tree.root);
  }
  return roots.slice(-depth);
}
