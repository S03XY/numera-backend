import { PoolLeafKind } from '@prisma/client';
import { decodeFunctionData } from 'viem';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChainService } from '../chain/chain.service';
import { RelayService } from '../relay/relay.service';
import { PoolIndexerService } from './pool-indexer.service';
import { PoolRejected, PoolService } from './pool.service';
import { POOL_ENTRYPOINT_ABI } from './pool.abi';
import { aspRootHistory, buildAspTree } from './pool.tree';
import type { PoolShieldDto, PoolWithdrawDto } from './dto/pool.dto';

/**
 * What the pool service refuses, and the one ordering it must never get wrong.
 *
 * These endpoints are unauthenticated by design, so every defence they have is a refusal. Two of
 * them are load-bearing beyond the usual:
 *
 *  - a proof against an association set we did not compute would let a caller choose which deposits
 *    count as approved, which is the entire purpose of having a set;
 *  - publishing a root *after* relaying, or relaying two proofs against different roots
 *    concurrently, fails on chain with a revert that names neither the cause nor the caller.
 */

const ENTRYPOINT = '0xde3131ea3680c4e470c12c8f5b1262ca6a657357';
const PRIVACY_POOL = '0xc52f2f283329c2fd7b5ebe60760c4051a064c97f';
const USDC = '0xb950d6ab271c752f3b27dbc10441f4e1ca4d71af';
const ACCOUNT = '0x9d3591e2b1054670018717bCB0194BE65099B769';
const SIGNATURE = `0x${'ab'.repeat(65)}`;

const LEAVES = [
  {
    kind: PoolLeafKind.DEPOSIT,
    commitment: '111',
    label: '7',
    value: '1000000',
    precommitment: '55',
    spentNullifier: null,
  },
  {
    kind: PoolLeafKind.DEPOSIT,
    commitment: '222',
    label: '9',
    value: '2000000',
    precommitment: '66',
    spentNullifier: null,
  },
  {
    kind: PoolLeafKind.CHANGE,
    commitment: '333',
    label: null,
    value: '400000',
    precommitment: null,
    spentNullifier: '77',
  },
];

const CURRENT_ASP_ROOT = buildAspTree(LEAVES).root;
const PREVIOUS_ASP_ROOT = aspRootHistory(LEAVES)[0];

interface Harness {
  service: PoolService;
  sent: Array<{ to: string; data: `0x${string}`; label: string }>;
  latestRoot: { value: bigint };
  findMany: jest.Mock;
}

function harness(
  overrides: {
    enabled?: boolean;
    synced?: boolean;
    latestRoot?: bigint;
    sendFails?: boolean;
  } = {},
): Harness {
  const sent: Array<{ to: string; data: `0x${string}`; label: string }> = [];
  const latestRoot = { value: overrides.latestRoot ?? CURRENT_ASP_ROOT };

  const cfg = {
    pool: {
      enabled: overrides.enabled ?? true,
      entrypoint: ENTRYPOINT,
      privacyPool: PRIVACY_POOL,
      startBlock: 0n,
    },
    chain: { chainId: 10143, addresses: { usdc: USDC } },
  } as unknown as AppConfigService;

  const findMany = jest.fn().mockResolvedValue(LEAVES);
  const prisma = { poolLeaf: { findMany } } as unknown as PrismaService;

  const chain = {
    isReady: true,
    readUint: jest.fn(async (_address: string, _abi: unknown, fn: string) => {
      if (fn === 'latestRoot') return latestRoot.value;
      if (fn === 'SCOPE') return 4242n;
      if (fn === 'currentRoot') return 999n;
      return 0n;
    }),
  } as unknown as ChainService;

  const mined = new Set<string>();
  const relay = {
    receiptFor: jest.fn(async (hash: string) => ({
      status: mined.has(hash) ? ('success' as const) : ('reverted' as const),
    })),
    sendFromRelayer: jest.fn(async (to: string, data: `0x${string}`, label: string) => {
      if (overrides.sendFails) throw new Error('simulation reverted');
      sent.push({ to, data, label });
      // Mirror the chain: publishing a root actually changes what the entrypoint reports.
      const decoded = decodeFunctionData({ abi: POOL_ENTRYPOINT_ABI, data });
      if (decoded.functionName === 'updateRoot') {
        latestRoot.value = decoded.args[0] as bigint;
      }
      // A distinct hash per send, so the receipt check can distinguish them.
      const hash = `0x${String(sent.length).padStart(64, '0')}`;
      mined.add(hash);
      return hash;
    }),
  } as unknown as RelayService;

  const indexer = { isSynced: overrides.synced ?? true } as unknown as PoolIndexerService;

  return { service: new PoolService(cfg, prisma, chain, relay, indexer), sent, latestRoot, findMany };
}

function withdrawal(aspRoot: bigint, processooor = ENTRYPOINT): PoolWithdrawDto {
  const signals = ['1', '2', '4000000', '999', '3', aspRoot.toString(), '2', '8'];
  return {
    withdrawal: { processooor, data: `0x${'0'.repeat(24)}${ACCOUNT.slice(2)}` },
    proof: {
      pA: ['1', '2'],
      pB: [
        ['3', '4'],
        ['5', '6'],
      ],
      pC: ['7', '8'],
      pubSignals: signals,
    },
  };
}

function shield(overrides: Partial<PoolShieldDto['request']> = {}): PoolShieldDto {
  return {
    request: {
      owner: ACCOUNT,
      value: '4000000',
      precommitment: '12345',
      deadline: String(Math.floor(Date.now() / 1000) + 3600),
      ...overrides,
    },
    signature: SIGNATURE,
  };
}

describe('PoolService', () => {
  describe('state', () => {
    it('serves the leaves in tree order with both roots', async () => {
      const { service } = harness();

      const state = await service.state();

      expect(state.enabled).toBe(true);
      expect(state.leaves.map((l) => l.index)).toEqual([0, 1, 2]);
      expect(state.leaves.map((l) => l.commitment)).toEqual(['111', '222', '333']);
      expect(state.stateRoot).toBe('999');
      expect(state.aspRoot).toBe(CURRENT_ASP_ROOT.toString());
      expect(state.scope).toBe('4242');
    });

    it('orders by chain position, never by insertion id', async () => {
      const { service, findMany } = harness();

      await service.state();

      expect(findMany).toHaveBeenCalledWith({
        orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
      });
    });

    it('reports the index still catching up rather than serving a short tree silently', async () => {
      const { service } = harness({ synced: false });

      expect((await service.state()).synced).toBe(false);
    });

    it('answers with a disabled shape when no pool is configured', async () => {
      const { service } = harness({ enabled: false });

      const state = await service.state();

      expect(state.enabled).toBe(false);
      expect(state.leaves).toEqual([]);
    });
  });

  describe('withdraw', () => {
    it('publishes the proof’s association root, then relays, in that order', async () => {
      const { service, sent } = harness({ latestRoot: 1n });

      await service.withdraw(withdrawal(CURRENT_ASP_ROOT));

      expect(sent).toHaveLength(2);
      expect(decodeFunctionData({ abi: POOL_ENTRYPOINT_ABI, data: sent[0].data }).functionName).toBe(
        'updateRoot',
      );
      expect(decodeFunctionData({ abi: POOL_ENTRYPOINT_ABI, data: sent[1].data }).functionName).toBe(
        'relay',
      );
    });

    it('skips the root update when the chain already holds it', async () => {
      const { service, sent } = harness({ latestRoot: CURRENT_ASP_ROOT });

      await service.withdraw(withdrawal(CURRENT_ASP_ROOT));

      // `updateRoot` reverts on an unchanged root by design, so publishing unconditionally would
      // fail every second withdrawal.
      expect(sent).toHaveLength(1);
      expect(decodeFunctionData({ abi: POOL_ENTRYPOINT_ABI, data: sent[0].data }).functionName).toBe(
        'relay',
      );
    });

    it('accepts a proof against a recent set, republishing that older root', async () => {
      const { service, sent, latestRoot } = harness({ latestRoot: CURRENT_ASP_ROOT });

      // The trader started proving before the second deposit landed. Their proof is still good.
      await service.withdraw(withdrawal(PREVIOUS_ASP_ROOT));

      expect(latestRoot.value).toBe(PREVIOUS_ASP_ROOT);
      expect(sent).toHaveLength(2);
    });

    it('refuses a proof against an association set we did not compute', async () => {
      const { service, sent } = harness();

      await expect(service.withdraw(withdrawal(123456789n))).rejects.toMatchObject({
        kind: 'stale',
      });
      expect(sent).toHaveLength(0);
    });

    it('refuses a withdrawal processed by anything but the entrypoint', async () => {
      const { service, sent } = harness();

      const bad = withdrawal(CURRENT_ASP_ROOT, '0x1111111111111111111111111111111111111111');

      await expect(service.withdraw(bad)).rejects.toMatchObject({ kind: 'invalid' });
      expect(sent).toHaveLength(0);
    });

    it('refuses while the leaf index is still catching up', async () => {
      const { service, sent } = harness({ synced: false });

      await expect(service.withdraw(withdrawal(CURRENT_ASP_ROOT))).rejects.toMatchObject({
        kind: 'stale',
      });
      expect(sent).toHaveLength(0);
    });

    it('refuses when no pool is configured', async () => {
      const { service } = harness({ enabled: false });

      await expect(service.withdraw(withdrawal(CURRENT_ASP_ROOT))).rejects.toMatchObject({
        kind: 'unavailable',
      });
    });

    it('reports a failed submission as sent nothing, spent nothing', async () => {
      const { service } = harness({ sendFails: true, latestRoot: CURRENT_ASP_ROOT });

      await expect(service.withdraw(withdrawal(CURRENT_ASP_ROOT))).rejects.toBeInstanceOf(
        PoolRejected,
      );
    });

    /**
     * The concurrency bug this lock exists for: publish(A), publish(B), relay(A) sends three valid
     * transactions and the third reverts, because A's proof pins root A and the chain holds B.
     */
    /**
     * `sendFromRelayer` returns on *broadcast*, not on mining. The relay that follows is simulated
     * against the chain as it is now — so without waiting, the pool re-derives `IncorrectASPRoot`
     * and the trader is told the contract rejected their withdrawal, for a condition that was
     * about to stop being true. Nonce ordering does not help: both simulations happen first.
     */
    it('waits for the root update to be mined before relaying (REGRESSION)', async () => {
      const { service } = harness({ latestRoot: 1n });

      await service.withdraw(withdrawal(CURRENT_ASP_ROOT));

      expect(
        (service as unknown as { relay: { receiptFor: jest.Mock } }).relay.receiptFor,
      ).toHaveBeenCalledTimes(1);
    });

    it('does not relay when the root update failed to land (negative)', async () => {
      const { service, sent } = harness({ latestRoot: 1n });
      const relay = (service as unknown as { relay: { receiptFor: jest.Mock } }).relay;
      relay.receiptFor.mockResolvedValue({ status: 'reverted' });

      await expect(service.withdraw(withdrawal(CURRENT_ASP_ROOT))).rejects.toMatchObject({
        kind: 'stale',
      });
      // The update was attempted; the proof was not, because it would have been rejected.
      expect(sent).toHaveLength(1);
    });

    it('never interleaves one withdrawal’s root update with another’s relay', async () => {
      const { service, sent } = harness({ latestRoot: 1n });

      await Promise.all([
        service.withdraw(withdrawal(CURRENT_ASP_ROOT)),
        service.withdraw(withdrawal(PREVIOUS_ASP_ROOT)),
      ]);

      const names = sent.map(
        (s) => decodeFunctionData({ abi: POOL_ENTRYPOINT_ABI, data: s.data }).functionName,
      );
      // Whatever order the two withdrawals resolve in, each update is immediately followed by its
      // own relay.
      for (let i = 0; i < names.length; i += 1) {
        if (names[i] === 'updateRoot') expect(names[i + 1]).toBe('relay');
      }
    });
  });

  describe('shield', () => {
    it('submits depositFor when the allowance already exists', async () => {
      const { service, sent } = harness();

      await service.shield(shield());

      expect(sent).toHaveLength(1);
      const decoded = decodeFunctionData({ abi: POOL_ENTRYPOINT_ABI, data: sent[0].data });
      expect(decoded.functionName).toBe('depositFor');
      expect((decoded.args[0] as { owner: string }).owner.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    });

    it('bundles the permit when the account has no allowance to spend', async () => {
      const { service, sent } = harness();

      await service.shield({
        ...shield(),
        permit: {
          deadline: String(Math.floor(Date.now() / 1000) + 3600),
          v: 27,
          r: `0x${'11'.repeat(32)}`,
          s: `0x${'22'.repeat(32)}`,
        },
      });

      expect(decodeFunctionData({ abi: POOL_ENTRYPOINT_ABI, data: sent[0].data }).functionName).toBe(
        'depositForWithPermit',
      );
    });

    it('passes the signed precommitment through untouched', async () => {
      const { service, sent } = harness();

      await service.shield(shield({ precommitment: '987654321' }));

      const decoded = decodeFunctionData({ abi: POOL_ENTRYPOINT_ABI, data: sent[0].data });
      // Altering it is the one attack an open endpoint would enable, and the contract rejects it —
      // but the relayer should not be the thing that tries.
      expect((decoded.args[0] as { precommitment: bigint }).precommitment).toBe(987654321n);
    });

    it('refuses an expired instruction before spending gas on it', async () => {
      const { service, sent } = harness();

      await expect(
        service.shield(shield({ deadline: String(Math.floor(Date.now() / 1000) - 1) })),
      ).rejects.toMatchObject({ kind: 'invalid' });
      expect(sent).toHaveLength(0);
    });

    it('refuses a return of nothing', async () => {
      const { service, sent } = harness();

      await expect(service.shield(shield({ value: '0' }))).rejects.toMatchObject({
        kind: 'invalid',
      });
      expect(sent).toHaveLength(0);
    });

    it('refuses when no pool is configured', async () => {
      const { service } = harness({ enabled: false });

      await expect(service.shield(shield())).rejects.toMatchObject({ kind: 'unavailable' });
    });
  });
});
