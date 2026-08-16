import { PoolLeafKind } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChainService } from '../chain/chain.service';
import { PoolIndexerService } from './pool-indexer.service';

/**
 * The leaf mirror, and the two ways it can be silently wrong.
 *
 * A missing or misordered leaf does not fail here. It fails much later, on chain, as an
 * `UnknownStateRoot` revert against a proof somebody spent thirty seconds generating — and it fails
 * for *everyone*, including people who deposited long before the gap, because an append-only tree
 * shifts every index after the hole.
 */

const PRIVACY_POOL = '0xc52f2f283329c2fd7b5ebe60760c4051a064c97f';

function deposited(blockNumber: bigint, logIndex: number) {
  return {
    eventName: 'Deposited',
    args: {
      _depositor: '0x1111111111111111111111111111111111111111',
      _commitment: 111n,
      _label: 7n,
      _value: 1_000_000n,
      _precommitmentHash: 55n,
    },
    blockNumber,
    transactionHash: `0xAA${String(logIndex).padStart(2, '0')}`,
    logIndex,
  };
}

function withdrawn(blockNumber: bigint, logIndex: number) {
  return {
    eventName: 'Withdrawn',
    args: {
      _processooor: '0x2222222222222222222222222222222222222222',
      _value: 400_000n,
      _spentNullifier: 77n,
      _newCommitment: 333n,
    },
    blockNumber,
    transactionHash: `0xBB${String(logIndex).padStart(2, '0')}`,
    logIndex,
  };
}

interface Harness {
  service: PoolIndexerService;
  transactions: unknown[][];
  upserts: Array<{ create: Record<string, unknown> }>;
}

function harness(logs: unknown[], head = 1_000n): Harness {
  const upserts: Array<{ create: Record<string, unknown> }> = [];
  const transactions: unknown[][] = [];

  const cfg = {
    pool: { enabled: true, entrypoint: '0x0', privacyPool: PRIVACY_POOL, startBlock: 100n },
    chain: {
      indexerEnabled: true,
      confirmations: 2n,
      batchBlocks: 100n,
      pollIntervalMs: 1_000,
    },
  } as unknown as AppConfigService;

  const prisma = {
    poolLeaf: {
      upsert: jest.fn((arg: { create: Record<string, unknown> }) => {
        upserts.push(arg);
        return arg;
      }),
    },
    indexerCursor: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn((arg: unknown) => arg),
    },
    $transaction: jest.fn(async (ops: unknown[]) => {
      transactions.push(ops);
      return ops;
    }),
  } as unknown as PrismaService;

  const chain = {
    isReady: true,
    getBlockNumber: jest.fn().mockResolvedValue(head),
    getLogs: jest.fn().mockResolvedValue(logs),
  } as unknown as ChainService;

  return { service: new PoolIndexerService(cfg, prisma, chain), transactions, upserts };
}

describe('PoolIndexerService', () => {
  it('mirrors a deposit with everything a browser needs to recognise it', async () => {
    const { service, upserts } = harness([deposited(101n, 0)]);

    await service.tick();

    expect(upserts[0].create).toMatchObject({
      kind: PoolLeafKind.DEPOSIT,
      commitment: '111',
      label: '7',
      value: '1000000',
      // How a browser identifies its own deposit without telling anyone which one it is.
      precommitment: '55',
    });
  });

  it('mirrors a withdrawal, because spending part of a note inserts a leaf too', async () => {
    const { service, upserts } = harness([withdrawn(101n, 0)]);

    await service.tick();

    expect(upserts[0].create).toMatchObject({
      kind: PoolLeafKind.CHANGE,
      commitment: '333',
      spentNullifier: '77',
    });
    // No label: the remainder inherits its parent's lineage and is never in the association set.
    // Asserted as absent rather than as `undefined`, which `toMatchObject` treats as a wildcard.
    expect(upserts[0].create).not.toHaveProperty('label');
  });

  it('writes leaves in chain order however the RPC returns them', async () => {
    const { service, upserts } = harness([
      deposited(105n, 1),
      withdrawn(101n, 3),
      deposited(101n, 0),
    ]);

    await service.tick();

    expect(upserts.map((u) => [u.create.blockNumber, u.create.logIndex])).toEqual([
      [101n, 0],
      [101n, 3],
      [105n, 1],
    ]);
  });

  it('commits the leaves and the cursor in one transaction', async () => {
    const { service, transactions } = harness([deposited(101n, 0), deposited(102n, 0)]);

    await service.tick();

    // Two leaves plus the cursor. A crash between them would leave the cursor claiming a span
    // whose leaves were never written — the one gap that cannot be recovered from.
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toHaveLength(3);
  });

  it('stays behind the unstable tip', async () => {
    const { service } = harness([], 150n);
    const chain = (service as unknown as { chain: ChainService }).chain;

    await service.tick();

    // head 150, confirmations 2 → safe head 148, and the batch starts at the configured 100.
    expect(chain.getLogs).toHaveBeenCalledWith(PRIVACY_POOL, expect.anything(), 100n, 148n);
  });

  it('reports itself synced only once it reaches the safe head', async () => {
    const { service } = harness([], 150n);

    expect(service.isSynced).toBe(false);
    await service.tick();
    expect(service.isSynced).toBe(true);
  });

  it('does not claim to be synced after a partial catch-up batch', async () => {
    const { service } = harness([], 10_000n);

    // Safe head 9998, batch width 100 — this tick covers 100..199 and nothing more.
    expect(await service.tick()).toBe(false);
    expect(service.isSynced).toBe(false);
  });

  it('ignores events that are not leaves', async () => {
    const { service, upserts } = harness([
      { eventName: 'PoolDied', args: {}, blockNumber: 101n, transactionHash: '0xCC', logIndex: 0 },
    ]);

    await service.tick();

    expect(upserts).toHaveLength(0);
  });
});
