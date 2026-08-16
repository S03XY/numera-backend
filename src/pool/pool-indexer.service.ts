import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PoolLeafKind, Prisma } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChainService } from '../chain/chain.service';
import { PRIVACY_POOL_EVENTS } from './pool.abi';

/** Its own cursor, deliberately. See the class doc. */
const CURSOR_STREAM = 'pool';

/**
 * How long to wait between catch-up ticks.
 *
 * Not zero, which is what the market indexer uses and what this used first. Monad's public RPC
 * answers `requests limited to 25/sec`, and the market indexer already spends most of that budget:
 * it fetches up to eighteen 100-block ranges per tick and loops with no delay whenever it is
 * behind. Adding a second unthrottled crawler took *both* over the limit, and a rate-limited tick
 * fails wholesale and re-runs the same span — so the two indexers made each other slower while
 * appearing to be broken.
 *
 * This one can afford to yield. It reads one contract, one range at a time, and a pool that is a
 * day old is a few hundred requests behind rather than a few thousand. Deliberately staying out of
 * the way costs seconds at boot and stops the market data — which every page depends on — from
 * being starved by a tree that only matters once somebody places a private bet.
 */
const CATCHUP_DELAY_MS = 150;

/**
 * Mirrors the shielded pool's state tree into `pool_leaves`.
 *
 * ## Why this is not a stream on the main indexer
 *
 * It could have been — `IndexerService` already crawls ranges, chunks around Monad's 100-block
 * `getLogs` cap and persists a cursor, and adding a fourth stream would have been six lines.
 *
 * It is separate because the two have incompatible failure modes. The market indexer's rows are
 * independent: a missed `Bought` costs one trade in the UI until somebody re-scans. A missed
 * `Deposited` costs *everything*, for *everyone* — the tree is append-only, so one absent leaf
 * shifts every index after it and produces a root that matches no root the chain has ever held.
 * Every withdrawal proof built on it is rejected with `UnknownStateRoot`, including proofs by
 * people who deposited long before the gap.
 *
 * Sharing a cursor would mean the pool advances past blocks it never read whenever the market
 * indexer commits, which is precisely the way to get that gap. So: one cursor, written only after
 * the leaves in that span are committed, in the same transaction.
 *
 * ## Confirmations
 *
 * The same `INDEXER_CONFIRMATIONS` as everything else. A reorg that drops a deposit would leave a
 * phantom leaf, and the `@@unique([txHash, logIndex])` upsert does not remove rows — it only
 * refuses to duplicate them. Staying behind the unstable tip is what prevents that; Monad's finality
 * makes it close to theoretical, and "close to theoretical" is not a thing to build a Merkle tree on.
 */
@Injectable()
export class PoolIndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PoolIndexerService.name);
  private stopped = false;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  /** Set once the cursor has reached the safe head at least once. */
  private caughtUp = false;

  constructor(
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
  ) {}

  onModuleInit(): void {
    const { enabled, privacyPool, startBlock } = this.cfg.pool;
    if (!enabled) {
      this.log.log('shielded pool not configured — leaf indexer not starting');
      return;
    }
    if (!this.cfg.chain.indexerEnabled) {
      this.log.warn('INDEXER_ENABLED=false — the pool state tree will not be maintained');
      return;
    }
    if (!this.chain.isReady) {
      this.log.warn('chain client not ready — pool leaf indexer not starting');
      return;
    }
    this.log.log(`pool leaf indexer starting on ${privacyPool} from block ${startBlock}`);
    void this.loop();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Whether the mirror can be trusted to be complete to the safe head. */
  get isSynced(): boolean {
    return this.caughtUp;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), delayMs);
  }

  private async loop(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const done = await this.tick();
      this.running = false;
      this.schedule(done ? this.cfg.chain.pollIntervalMs : CATCHUP_DELAY_MS);
    } catch (err) {
      this.running = false;
      // Never advance the cursor on failure: the next tick re-reads the same span. Re-reading is
      // free (the upsert is idempotent) and skipping is unrecoverable.
      this.log.error(`pool indexer tick failed: ${(err as Error).message}`);
      this.schedule(this.cfg.chain.pollIntervalMs);
    }
  }

  /** One step. Returns true when the safe head has been reached. */
  async tick(): Promise<boolean> {
    const head = await this.chain.getBlockNumber();
    const confirmations = this.cfg.chain.confirmations;
    const safeHead = head > confirmations ? head - confirmations : 0n;

    const from = await this.nextFromBlock();
    if (from > safeHead) {
      this.caughtUp = true;
      return true;
    }

    const width = this.cfg.chain.batchBlocks;
    const to = from + width - 1n < safeHead ? from + width - 1n : safeHead;

    const logs = await this.chain.getLogs(
      this.cfg.pool.privacyPool as `0x${string}`,
      PRIVACY_POOL_EVENTS,
      from,
      to,
    );

    const rows = logs
      .map((raw) => this.toLeaf(raw))
      .filter((row): row is Prisma.PoolLeafCreateInput => row !== null)
      // Block, then log index within the block: the order the tree was built in. The RPC usually
      // returns them this way and is not obliged to.
      .sort((a, b) =>
        a.blockNumber === b.blockNumber
          ? a.logIndex - b.logIndex
          : Number(BigInt(a.blockNumber as bigint) - BigInt(b.blockNumber as bigint)),
      );

    // Leaves and cursor commit together. A crash between them would leave the cursor claiming a
    // span whose leaves were never written, which is the one failure this whole file exists to
    // prevent.
    await this.prisma.$transaction([
      ...rows.map((row) =>
        this.prisma.poolLeaf.upsert({
          where: { txHash_logIndex: { txHash: row.txHash, logIndex: row.logIndex } },
          create: row,
          update: row,
        }),
      ),
      this.prisma.indexerCursor.upsert({
        where: { stream: CURSOR_STREAM },
        create: { stream: CURSOR_STREAM, lastBlock: to },
        update: { lastBlock: to },
      }),
    ]);

    if (rows.length > 0) {
      this.log.log(`indexed ${rows.length} pool leaf/leaves in blocks [${from}, ${to}]`);
    }

    const done = to >= safeHead;
    if (done) this.caughtUp = true;
    return done;
  }

  /** One decoded log into a row, or null for an event we do not mirror. */
  private toLeaf(raw: unknown): Prisma.PoolLeafCreateInput | null {
    const log = raw as {
      eventName?: string;
      args?: Record<string, unknown>;
      blockNumber?: bigint;
      transactionHash?: string;
      logIndex?: number;
    };
    const args = log.args ?? {};
    const base = {
      blockNumber: log.blockNumber ?? 0n,
      logIndex: log.logIndex ?? 0,
      txHash: (log.transactionHash ?? '').toLowerCase(),
    };

    if (log.eventName === 'Deposited') {
      return {
        ...base,
        kind: PoolLeafKind.DEPOSIT,
        commitment: String(args._commitment),
        label: String(args._label),
        value: String(args._value),
        precommitment: String(args._precommitmentHash),
      };
    }

    if (log.eventName === 'Withdrawn') {
      /*
        A withdrawal inserts a leaf too, and forgetting that is the single easiest way to break
        this pool. Spending part of a note mints a fresh note for the remainder, and that
        commitment goes into the same tree in the same order as any deposit.

        It carries no label: the remainder inherits the lineage of the note it came from, and only
        deposits are ever entered into the association set. Which means ASP indices and state
        indices diverge the moment anybody withdraws — see `pool.service.ts`.
      */
      return {
        ...base,
        kind: PoolLeafKind.CHANGE,
        commitment: String(args._newCommitment),
        value: String(args._value),
        spentNullifier: String(args._spentNullifier),
      };
    }

    return null;
  }

  private async nextFromBlock(): Promise<bigint> {
    const cursor = await this.prisma.indexerCursor.findUnique({ where: { stream: CURSOR_STREAM } });
    if (!cursor) return this.cfg.pool.startBlock;
    return cursor.lastBlock + 1n;
  }
}
