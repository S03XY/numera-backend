import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Abi } from 'viem';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChainService } from './chain.service';
import { EventProcessor, NormalizedLog, StreamKind } from './event-processor.service';
import { BLOCKLIST_EVENTS, LS_LMSR_EVENTS, OPTIMISTIC_RESOLVER_EVENTS } from './abis';

interface Stream {
  address: `0x${string}`;
  kind: StreamKind;
  events: Abi;
}

const CURSOR_STREAM = 'main';

/**
 * How many `getLogs` requests one tick may have in flight.
 *
 * One range per tick is latency-bound, not bandwidth-bound: Monad caps
 * `eth_getLogs` at 100 blocks, so a tick moves 100 blocks per round trip and the
 * indexer crawls at ~55 blocks/sec however quiet the chain is. After an outage
 * that is hours of lag — a laptop asleep overnight left it 192,000 blocks
 * behind, an hour during which every new trade was missing from the UI.
 *
 * The ceiling is the RPC's own rate limit, not our appetite: Monad's public node
 * answers `requests limited to 25/sec`, and a tick that exceeds it fails
 * wholesale and re-runs the same span, which is slower than never having asked.
 * This is deliberately under that, leaving room for the block-timestamp calls
 * (which ride a separate, batched transport and cost one request per tick).
 *
 * Concurrency only pays off because `ChainService` gives `getLogs` an UNBATCHED
 * transport — with JSON-RPC batching on, concurrent ranges are coalesced into
 * one serially-answered request and the parallelism buys nothing.
 *
 * Lowered from 18 when the shielded pool's leaf indexer arrived. This was already close enough to
 * Monad's ceiling that a second crawler on the same node pushed both over it, and a rate-limited
 * tick fails wholesale and re-runs the same span — so the two made each other slower while looking
 * like an RPC outage. The pool indexer throttles itself as well; both halves were needed.
 */
const MAX_LOG_REQUESTS_IN_FLIGHT = 14;

/** On-chain order: block first, then position within the block. */
function byChainOrder(a: NormalizedLog, b: NormalizedLog): number {
  if (a.blockNumber === b.blockNumber) return a.logIndex - b.logIndex;
  return a.blockNumber < b.blockNumber ? -1 : 1;
}

/**
 * Reorg-safe, resumable event indexer.
 *
 *  - Processes only up to `head - confirmations` (never the unstable tip).
 *  - Backfills in `batchBlocks`-sized getLogs pages from a persisted cursor.
 *  - Idempotent: trades upsert on (txHash, logIndex), so re-scanning a range
 *    after a crash/reorg rewrites the same rows rather than duplicating.
 *  - Advances the cursor only after a batch fully commits.
 */
@Injectable()
export class IndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexerService.name);
  private streams: Stream[] = [];
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    private readonly processor: EventProcessor,
  ) {}

  onModuleInit(): void {
    const { indexerEnabled, addresses } = this.cfg.chain;
    if (!indexerEnabled) {
      this.logger.log('indexer disabled (INDEXER_ENABLED=false)');
      return;
    }
    if (!this.chain.isReady) {
      this.logger.warn('indexer enabled but chain client not ready — not starting');
      return;
    }
    if (addresses.lsLmsr) {
      this.streams.push({ address: addresses.lsLmsr, kind: 'LS_LMSR', events: LS_LMSR_EVENTS });
    }
    // Resolution and bans are separate contracts with separate lifetimes, so they are separate
    // streams — but they share the one cursor, because a resolution and the settlement it causes
    // land in the same block and must be applied in chain order or the market would briefly read
    // as settled with no proposal behind it.
    if (addresses.optimisticResolver) {
      this.streams.push({
        address: addresses.optimisticResolver,
        kind: 'OPTIMISTIC_RESOLVER',
        events: OPTIMISTIC_RESOLVER_EVENTS,
      });
    }
    if (addresses.blocklist) {
      this.streams.push({
        address: addresses.blocklist,
        kind: 'TRADING_BLOCKLIST',
        events: BLOCKLIST_EVENTS,
      });
    }

    if (this.streams.length === 0) {
      this.logger.warn('indexer enabled but no contract addresses configured — not starting');
      return;
    }
    this.logger.log(`indexer starting over ${this.streams.length} stream(s)`);
    void this.loop();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), delayMs);
  }

  private async loop(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const caughtUp = await this.tick();
      this.running = false;
      // If still catching up, run again immediately; else wait a poll interval.
      this.schedule(caughtUp ? this.cfg.chain.pollIntervalMs : 0);
    } catch (err) {
      this.running = false;
      this.logger.error(`indexer tick failed: ${(err as Error).message}`);
      this.schedule(this.cfg.chain.pollIntervalMs); // back off, retry from same cursor
    }
  }

  /** One indexing step. Returns true when the safe head has been reached. */
  private async tick(): Promise<boolean> {
    const head = await this.chain.getBlockNumber();
    const safeHead = head > this.cfg.chain.confirmations ? head - this.cfg.chain.confirmations : 0n;

    const from = await this.nextFromBlock();
    if (from > safeHead) return true; // nothing new that is final yet

    // At the tip this is a single range and behaves exactly as before. Only when
    // there is real ground to make up do we widen, so steady-state polling stays
    // one request per stream per tick.
    const ranges = this.plan(from, safeHead);
    const to = ranges[ranges.length - 1].to;

    // Ranges are fetched concurrently but merged into one chain-ordered batch,
    // so the processor still sees events in exactly the order they happened.
    const logs = (await Promise.all(ranges.map((r) => this.collectLogs(r.from, r.to))))
      .flat()
      .sort(byChainOrder);

    if (logs.length > 0) {
      this.logger.debug(`processing ${logs.length} log(s) in blocks [${from}, ${to}]`);
      await this.processor.processBatch(logs);
    }
    // One cursor write for the whole span: it advances only after every range in
    // it has committed, so a crash re-scans rather than skipping.
    await this.saveCursor(to);

    // Falling behind is the failure mode nobody notices: the API keeps serving
    // and every answer is simply stale, so a trade that settled minutes ago is
    // still missing from the market and the user concludes the app is broken.
    // Say so, at a volume proportional to how bad it is.
    const lag = safeHead - to;
    if (lag > 0n) {
      const line = `indexer catching up: ${lag} block(s) behind (at ${to})`;
      if (lag > 5_000n) {
        // Loud, and rate-limited to once per ~500 batches so catch-up does not
        // drown every other log line.
        if (to % (this.cfg.chain.batchBlocks * 500n) < this.cfg.chain.batchBlocks) {
          this.logger.warn(line);
        }
      } else {
        this.logger.debug(line);
      }
    }
    return to >= safeHead;
  }

  /**
   * Split `[from, safeHead]` into the ranges this tick should fetch.
   *
   * One range when we are at the tip; up to {@link CATCHUP_RANGES} when behind.
   * Every range is `batchBlocks` wide except the last, which stops at the safe
   * head — never past it, so the unstable tip is still excluded.
   */
  private plan(from: bigint, safeHead: bigint): Array<{ from: bigint; to: bigint }> {
    const width = this.cfg.chain.batchBlocks;
    const ranges: Array<{ from: bigint; to: bigint }> = [];
    let cursor = from;

    // One getLogs per stream per range, so the range budget is the request
    // budget divided by the number of streams — correct as streams are added.
    const maxRanges = Math.max(1, Math.floor(MAX_LOG_REQUESTS_IN_FLIGHT / this.streams.length));

    while (cursor <= safeHead && ranges.length < maxRanges) {
      const end = cursor + width - 1n < safeHead ? cursor + width - 1n : safeHead;
      ranges.push({ from: cursor, to: end });
      cursor = end + 1n;
    }
    return ranges;
  }

  private async collectLogs(from: bigint, to: bigint): Promise<NormalizedLog[]> {
    const perStream = await Promise.all(
      this.streams.map(async (s) => {
        const raw = await this.chain.getLogs(s.address, s.events, from, to);
        return raw.map((l) => ({ stream: s, log: l }));
      }),
    );
    const flat = perStream.flat();

    // Attach block timestamps (memoized per block).
    const uniqueBlocks = [...new Set(flat.map((f) => f.log.blockNumber!))];
    const tsByBlock = new Map<string, number>();
    await Promise.all(
      uniqueBlocks.map(async (bn) => {
        tsByBlock.set(bn!.toString(), await this.chain.getBlockTimestamp(bn!));
      }),
    );

    const normalized: NormalizedLog[] = flat.map(({ stream, log }) => {
      const decoded = log as unknown as {
        eventName: string;
        args: Record<string, unknown>;
        blockNumber: bigint;
        transactionHash: string;
        logIndex: number;
      };
      return {
        kind: stream.kind,
        address: stream.address,
        eventName: decoded.eventName,
        args: decoded.args ?? {},
        blockNumber: decoded.blockNumber,
        txHash: decoded.transactionHash,
        logIndex: decoded.logIndex,
        timestamp: new Date((tsByBlock.get(decoded.blockNumber.toString()) ?? 0) * 1000),
      };
    });

    return normalized.sort(byChainOrder);
  }

  private async nextFromBlock(): Promise<bigint> {
    const cursor = await this.prisma.indexerCursor.findUnique({ where: { stream: CURSOR_STREAM } });
    if (!cursor) return this.cfg.chain.startBlock;
    return cursor.lastBlock + 1n;
  }

  private async saveCursor(lastBlock: bigint): Promise<void> {
    await this.prisma.indexerCursor.upsert({
      where: { stream: CURSOR_STREAM },
      create: { stream: CURSOR_STREAM, lastBlock },
      update: { lastBlock },
    });
  }
}
