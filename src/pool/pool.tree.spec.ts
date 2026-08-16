import { PoolLeafKind } from '@prisma/client';
import { poseidon2 } from 'poseidon-lite';
import { aspRootHistory, buildAspTree, buildStateTree, type PoolLeafRow } from './pool.tree';

/**
 * The two trees, and the three ways they get silently broken.
 *
 * Every failure here shows up on chain as the same thing — a revert naming a root — long after the
 * mistake, on a proof that took thirty seconds to generate. So they are pinned in the one place
 * where the cause is still visible.
 */

const deposit = (commitment: string, label: string): PoolLeafRow => ({
  kind: PoolLeafKind.DEPOSIT,
  commitment,
  label,
});

const change = (commitment: string): PoolLeafRow => ({
  kind: PoolLeafKind.CHANGE,
  commitment,
  label: null,
});

describe('pool trees', () => {
  describe('the state tree', () => {
    it('contains every leaf, deposits and change alike', () => {
      const withChange = buildStateTree([deposit('11', '1'), change('22'), deposit('33', '3')]);
      const withoutChange = buildStateTree([deposit('11', '1'), deposit('33', '3')]);

      expect(withChange.size).toBe(3);
      expect(withoutChange.size).toBe(2);
      // The failure this guards: rebuilding from deposits alone is correct until somebody
      // withdraws, and then permanently wrong for everyone.
      expect(withChange.root).not.toEqual(withoutChange.root);
    });

    it('is order-dependent, which is why nothing here sorts', () => {
      const forwards = buildStateTree([deposit('11', '1'), deposit('22', '2')]);
      const backwards = buildStateTree([deposit('22', '2'), deposit('11', '1')]);

      expect(forwards.root).not.toEqual(backwards.root);
    });

    it('hashes the way the pool does', () => {
      const tree = buildStateTree([deposit('11', '1'), deposit('22', '2')]);

      // `InternalLeanIMT` over Poseidon(2). Any other hash produces a root nothing accepts.
      expect(tree.root).toBe(poseidon2([11n, 22n]));
    });

    it('is empty for a pool nobody has used', () => {
      expect(buildStateTree([]).size).toBe(0);
    });
  });

  describe('the association-set tree', () => {
    it('holds labels, not commitments', () => {
      const tree = buildAspTree([deposit('11', '7'), deposit('22', '9')]);

      expect(tree.root).toBe(poseidon2([7n, 9n]));
    });

    it('skips change notes, so its indices diverge from the state tree', () => {
      const leaves = [deposit('11', '7'), change('22'), deposit('33', '9')];

      const state = buildStateTree(leaves);
      const asp = buildAspTree(leaves);

      expect(state.size).toBe(3);
      expect(asp.size).toBe(2);
      // A trader's third deposit is at state index 2 and ASP index 1. Passing one where the other
      // belongs generates a proof happily and is rejected on chain with no mention of either tree.
      expect(state.indexOf(33n)).toBe(2);
      expect(asp.indexOf(9n)).toBe(1);
    });
  });

  describe('the association root history', () => {
    it('records one root per deposit, oldest first', () => {
      const history = aspRootHistory([deposit('11', '7'), change('22'), deposit('33', '9')]);

      expect(history).toHaveLength(2);
      expect(history[1]).toBe(buildAspTree([deposit('11', '7'), deposit('33', '9')]).root);
    });

    it('ends with the current root, so a fresh proof is always accepted', () => {
      const leaves = [deposit('11', '7'), deposit('22', '9'), deposit('33', '5')];

      expect(aspRootHistory(leaves).at(-1)).toBe(buildAspTree(leaves).root);
    });

    it('keeps only the most recent window', () => {
      const leaves = Array.from({ length: 50 }, (_, i) => deposit(String(i + 1), String(i + 100)));

      const history = aspRootHistory(leaves, 8);

      expect(history).toHaveLength(8);
      expect(history.at(-1)).toBe(buildAspTree(leaves).root);
    });

    it('is empty before anybody has deposited', () => {
      expect(aspRootHistory([change('22')])).toEqual([]);
    });
  });
});
