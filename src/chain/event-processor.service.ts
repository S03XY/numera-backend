import { Injectable, Logger } from '@nestjs/common';
import { Engine, Prisma, ResolutionPhase, ResolutionRoute, TradeSide } from '@prisma/client';
import { hexToString } from 'viem';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PricesService } from '../prices/prices.service';
import { MarketsService } from '../markets/markets.service';
import { ChainService } from './chain.service';
import { parseCanonical } from '../admin/metadata-hash';
import {
  RealtimeEvent,
  RealtimeEventName,
  RealtimeMessage,
  globalChannel,
  marketChannel,
} from '../common/constants/realtime';

export type StreamKind = 'LS_LMSR' | 'OPTIMISTIC_RESOLVER' | 'TRADING_BLOCKLIST';

/** A decoded log the indexer hands to the processor, already tagged + timed. */
export interface NormalizedLog {
  kind: StreamKind;
  address: string;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  timestamp: Date;
}

const WAD = 10n ** 18n;

/**
 * `OptimisticResolver.INVALID_OUTCOME` — the sentinel meaning "void this market".
 *
 * Hard-coded rather than read, because it is `type(uint32).max` in a `constant` and cannot change
 * without a redeploy. Stored as `null`, so "no outcome named" and "the outcome is void" are the same
 * value in the database — which is right, since both mean nobody wins.
 */
const INVALID_OUTCOME = 4_294_967_295n;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function dec(v: bigint | number | string): Prisma.Decimal {
  return new Prisma.Decimal(v.toString());
}

/** An outcome index, or `null` when the assertion was "void this market". */
function outcomeOrVoid(raw: unknown): number | null {
  const v = raw as bigint;
  return v === INVALID_OUTCOME ? null : Number(v);
}

function bytes32ToString(hex: string): string {
  try {
    return hexToString(hex as `0x${string}`, { size: 32 }).replace(/\0+$/, '');
  } catch {
    return hex;
  }
}

/**
 * Applies decoded contract logs to the database and publishes realtime updates.
 * Pure DB/Redis logic (no RPC fetching) so it can be unit-tested directly. The
 * only chain read it performs is the authoritative LMSR price vector, during the
 * per-batch refresh of markets that were touched by trades.
 */
@Injectable()
export class EventProcessor {
  private readonly logger = new Logger(EventProcessor.name);
  private readonly refCache = new Map<string, string>(); // `${addr}:${marketId}` -> marketRef

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly prices: PricesService,
    private readonly markets: MarketsService,
    private readonly chain: ChainService,
  ) {}

  // ---- public entrypoints -------------------------------------------------

  /** Apply a block-ordered batch of logs, then refresh prices for touched markets. */
  async processBatch(logs: NormalizedLog[]): Promise<void> {
    const touched = new Set<string>();

    for (const log of logs) {
      try {
        await this.apply(log, touched);
      } catch (err) {
        this.logger.error(
          `failed to process ${log.kind}.${log.eventName} @ ${log.txHash}:${log.logIndex}`,
          err as Error,
        );
        throw err; // abort the batch so the cursor is not advanced past a gap
      }
    }

    for (const ref of touched) await this.refreshPrices(ref, logs);
  }

  // ---- dispatch -----------------------------------------------------------

  private async apply(log: NormalizedLog, touched: Set<string>): Promise<void> {
    const a = log.args;
    if (log.kind === 'LS_LMSR') {
      switch (log.eventName) {
        case 'MarketCreated':
          return void (await this.createMarket(log));
        case 'MarketMetadataPublished':
          return this.onMetadataPublished(log);
        case 'Bought':
          return this.onTrade(log, TradeSide.BUY, touched);
        case 'Sold':
          return this.onTrade(log, TradeSide.SELL, touched);
        case 'Shorted':
          return this.onShort(log, touched);
        case 'MarketResolved':
          return this.onResolved(log, Number(a.winningOutcomeId), a.owed as bigint, a.surplus as bigint);
        case 'MarketInvalidated':
          return this.onInvalidated(log, a.surplus as bigint);
        case 'Redeemed':
          return this.onRedeem(log);
        case 'SeedRedeemed':
          return this.onSeedRedeemed(log);
        default:
          return;
      }
    }

    if (log.kind === 'OPTIMISTIC_RESOLVER') {
      switch (log.eventName) {
        case 'Proposed':
          return this.onProposed(log);
        case 'Disputed':
          return this.onDisputed(log);
        case 'Finalized':
          return this.onFinalized(log);
        case 'Arbitrated':
          return this.onArbitrated(log);
        case 'Slashed':
          return this.onSlashed(log);
        // Both unwind a stake without settling anything, so the market goes back to being
        // unproposed. Same effect, two different causes.
        case 'ProposalAbandoned':
        case 'DisputeReset':
          return this.onResolutionCleared(log);
        default:
          return;
      }
    }

    if (log.kind === 'TRADING_BLOCKLIST') {
      switch (log.eventName) {
        case 'Banned':
          return this.onBanned(log);
        case 'Unbanned':
          return this.onUnbanned(log);
        default:
          return;
      }
    }
  }

  // ---- market creation ----------------------------------------------------

  private async createMarket(log: NormalizedLog): Promise<string> {
    const a = log.args;
    const address = log.address.toLowerCase();
    const marketId = a.marketId as bigint;
    const outcomeCount = Number(a.outcomeCount);
    const categoryKey = bytes32ToString(a.category as string) || null;
    // Never null: the engine substitutes the creation block's timestamp when a creator does not
    // name one, so "opens immediately" is a start time in the past rather than an absent field.
    const startTime = new Date(Number(a.startTime) * 1000);
    const closeTime = new Date(Number(a.closeTime) * 1000);
    const seedPerOutcome = a.seedPerOutcome as bigint;

    if (categoryKey) {
      await this.prisma.category.upsert({
        where: { key: categoryKey },
        create: { key: categoryKey, label: categoryKey },
        update: {},
      });
    }

    // A freshly seeded book holds an equal quantity of every outcome, so the opening prices are
    // uniform. The indexer writes them rather than reading the chain: a market is created and
    // then immediately listed, and one saved RPC round trip here is one less way the first
    // render can show a market with no prices at all.
    const uniformPrice = WAD / BigInt(outcomeCount);

    // Adopt operator-drafted copy if this market's on-chain metadataHash matches
    // a draft. The hash is the commitment, so the copy we serve is verifiable.
    const metadataHash = a.metadataHash as string;
    const draft = await this.prisma.marketMetadataDraft.findUnique({ where: { metadataHash } });
    const labels = draft?.outcomeLabels ?? [];

    const market = await this.prisma.market.upsert({
      where: { address_marketId: { address, marketId } },
      update: {},
      create: {
        engine: Engine.LS_LMSR,
        address,
        marketId,
        collateral: (a.collateral as string).toLowerCase(),
        resolver: (a.resolver as string).toLowerCase(),
        startTime,
        closeTime,
        outcomeCount,
        categoryKey,
        metadataHash,
        creator: (a.creator as string).toLowerCase(),
        alpha: dec(a.alpha as bigint),
        sStar: dec(a.sStar as bigint),
        seed: dec(seedPerOutcome),
        pot: dec(a.seedCost as bigint),
        title: draft?.title ?? '',
        description: draft?.description ?? '',
        resolutionRules: draft?.resolutionRules ?? '',
        imageUrl: draft?.imageUrl ?? null,
        createdBlock: log.blockNumber,
        createdTx: log.txHash,
        outcomes: {
          create: Array.from({ length: outcomeCount }, (_, i) => ({
            index: i,
            label: labels[i] ?? '',
            currentPriceWad: dec(uniformPrice),
            // The creator's seed is real outstanding stock and must be in `currentShares` from
            // the first block, or every price impact the UI computes will be wrong.
            currentShares: dec(seedPerOutcome),
          })),
        },
      },
    });

    if (draft && draft.marketRef === null) {
      await this.prisma.marketMetadataDraft.update({
        where: { metadataHash },
        data: { marketRef: market.id },
      });
    }

    this.refCache.set(`${address}:${marketId}`, market.id);
    await this.markets.invalidate(market.id);
    await this.publish(globalChannel(RealtimeEvent.MarketCreated), RealtimeEvent.MarketCreated, {
      marketRef: market.id,
      engine: Engine.LS_LMSR,
      marketId: marketId.toString(),
      address,
      categoryKey,
      closeTime: closeTime.toISOString(),
    });
    return market.id;
  }

  /**
   * Adopt the copy a market committed to, from the chain rather than from our own draft table.
   *
   * The engine emits this once, in the creation transaction, having already checked the string
   * against the `metadataHash` it stores immutably — and it has no function that can supersede it.
   * So this log *is* what the market promised, and taking the title, the description and above all
   * the resolution rules from it means the site cannot display terms a market did not make.
   *
   * `MarketCreated` seeds the row from a local draft one log earlier, which is what makes a market
   * appear instantly. This is the correction that follows: where the two disagree, the chain wins,
   * and a market created by somebody who never touched our admin API gets its copy anyway.
   *
   * A metadata string that does not hash to the market's commitment is dropped with a warning. It
   * cannot happen — the engine checks first — and if it ever does, serving unverifiable rules would
   * be worse than serving none.
   */
  private async onMetadataPublished(log: NormalizedLog): Promise<void> {
    const a = log.args;
    const marketId = a.marketId as bigint;
    const ref = await this.marketRef(log.address, marketId);
    if (!ref) return;

    const hash = a.metadataHash as string;
    const metadata = parseCanonical(a.metadata as string, hash);
    if (!metadata) {
      this.logger.warn(`market ${marketId}: published metadata does not match ${hash} — ignored`);
      return;
    }

    if (metadata.categoryKey) {
      await this.prisma.category.upsert({
        where: { key: metadata.categoryKey },
        create: { key: metadata.categoryKey, label: metadata.categoryKey },
        update: {},
      });
    }

    await this.prisma.market.update({
      where: { id: ref },
      data: {
        title: metadata.title,
        description: metadata.description,
        resolutionRules: metadata.resolutionRules,
        imageUrl: metadata.imageUrl,
        categoryKey: metadata.categoryKey,
      },
    });

    // Labels are inside the hash too, so they are as fixed as the rules are. Bounded by the
    // market's own outcome count: a longer array would be a metadata string that disagrees with
    // the market it belongs to, and the extra entries have nowhere to go.
    const market = await this.prisma.market.findUnique({
      where: { id: ref },
      select: { outcomeCount: true },
    });
    const labels = metadata.outcomeLabels.slice(0, market?.outcomeCount ?? 0);
    await Promise.all(
      labels.map((label, index) =>
        this.prisma.outcome.update({
          where: { marketRef_index: { marketRef: ref, index } },
          data: { label },
        }),
      ),
    );

    await this.markets.invalidate(ref);
  }

  // ---- trades -------------------------------------------------------------

  private async onTrade(log: NormalizedLog, side: TradeSide, touched: Set<string>): Promise<void> {
    const a = log.args;
    const ref = await this.marketRef(log.address, a.marketId as bigint);
    if (!ref) return;
    const outcomeIndex = Number(a.outcomeId);
    const shares = a.shares as bigint;
    const spreadWad = a.spreadWad as bigint;
    const amount = (side === TradeSide.BUY ? a.cost : a.proceeds) as bigint;
    const priceWad = shares > 0n ? (amount * WAD) / shares : 0n; // avg execution price

    await this.insertTrade(log, ref, side, outcomeIndex, shares, amount, spreadWad, priceWad);

    // The spread is already inside `amount` — the contract charges cost*(1+phi) and pays
    // proceeds*(1-phi) — so there is no separate fee leg to add or subtract here.
    const potDelta = side === TradeSide.BUY ? amount : -amount;
    const shareDelta = side === TradeSide.BUY ? shares : -shares;

    await this.prisma.market.update({
      where: { id: ref },
      data: { pot: { increment: dec(potDelta) } },
    });
    await this.prisma.outcome.update({
      where: { marketRef_index: { marketRef: ref, index: outcomeIndex } },
      data: { currentShares: { increment: dec(shareDelta) } },
    });

    await this.updatePosition(ref, a.account as string, outcomeIndex, side, shares, amount);
    touched.add(ref);

    await this.publishMarket(ref, RealtimeEvent.Trade, {
      side,
      account: (a.account as string).toLowerCase(),
      outcomeIndex,
      shares: shares.toString(),
      amount: amount.toString(),
      spreadWad: spreadWad.toString(),
      priceWad: priceWad.toString(),
      txHash: log.txHash,
      timestamp: log.timestamp.toISOString(),
    });
  }

  /**
   * A short: `buyComplement(i)` credits one share of every outcome EXCEPT `i`.
   *
   * The event names the outcome the trader took a view AGAINST, but the shares landed
   * everywhere else. Recording them against `outcomeId` would invert every short position in
   * the portfolio — the trader would appear long exactly the thing they bet against — so the
   * legs are fanned out explicitly here.
   *
   * The trade row still records `outcomeId`, because that is what the trader chose and what the
   * tape should show. Only the position ledger fans out.
   */
  private async onShort(log: NormalizedLog, touched: Set<string>): Promise<void> {
    const a = log.args;
    const ref = await this.marketRef(log.address, a.marketId as bigint);
    if (!ref) return;
    const market = await this.prisma.market.findUnique({ where: { id: ref } });
    if (!market) return;

    const shorted = Number(a.outcomeId);
    const shares = a.shares as bigint;
    const cost = a.cost as bigint;
    const spreadWad = a.spreadWad as bigint;
    const account = (a.account as string).toLowerCase();

    const legs: number[] = [];
    for (let i = 0; i < market.outcomeCount; i += 1) if (i !== shorted) legs.push(i);
    if (legs.length === 0) return;

    const priceWad = shares > 0n ? (cost * WAD) / shares : 0n;
    await this.insertTrade(log, ref, TradeSide.SHORT, shorted, shares, cost, spreadWad, priceWad);

    // Cost basis is split evenly across the legs, with the remainder on the last one so the
    // parts sum to the cost exactly. The legs are not equally priced, so this is an
    // approximation — but basis only drives displayed PnL, never settlement, and the exact
    // per-leg split is not recoverable from the event.
    const perLeg = cost / BigInt(legs.length);
    for (let k = 0; k < legs.length; k += 1) {
      const i = legs[k];
      const basis = k === legs.length - 1 ? cost - perLeg * BigInt(legs.length - 1) : perLeg;
      await this.prisma.outcome.update({
        where: { marketRef_index: { marketRef: ref, index: i } },
        data: { currentShares: { increment: dec(shares) } },
      });
      await this.updatePosition(ref, account, i, TradeSide.BUY, shares, basis);
    }

    await this.prisma.market.update({ where: { id: ref }, data: { pot: { increment: dec(cost) } } });
    touched.add(ref);

    await this.publishMarket(ref, RealtimeEvent.Trade, {
      side: TradeSide.SHORT,
      account,
      outcomeIndex: shorted,
      shares: shares.toString(),
      amount: cost.toString(),
      spreadWad: spreadWad.toString(),
      priceWad: priceWad.toString(),
      txHash: log.txHash,
      timestamp: log.timestamp.toISOString(),
    });
  }

  // ---- resolution ---------------------------------------------------------

  private async onResolved(
    log: NormalizedLog,
    winningOutcomeId: number,
    owed: bigint,
    surplus: bigint,
  ): Promise<void> {
    const ref = await this.marketRef(log.address, log.args.marketId as bigint);
    if (!ref) return;
    // The contract sweeps the surplus at resolution and retains exactly what it owes, so `pot`
    // is set to `owed` rather than decremented — it is now the outstanding liability and
    // nothing else.
    await this.prisma.market.update({
      where: { id: ref },
      data: { status: 'RESOLVED', winningOutcomeId, pot: dec(owed), surplus: dec(surplus) },
    });
    await this.markets.invalidate(ref);
    await this.publishMarket(ref, RealtimeEvent.MarketStatus, { status: 'RESOLVED', winningOutcomeId });
  }

  private async onInvalidated(log: NormalizedLog, surplus: bigint): Promise<void> {
    const ref = await this.marketRef(log.address, log.args.marketId as bigint);
    if (!ref) return;
    await this.prisma.market.update({
      where: { id: ref },
      data: { status: 'INVALID', surplus: dec(surplus) },
    });
    await this.markets.invalidate(ref);
    await this.publishMarket(ref, RealtimeEvent.MarketStatus, { status: 'INVALID' });
  }

  private async onRedeem(log: NormalizedLog): Promise<void> {
    const ref = await this.marketRef(log.address, log.args.marketId as bigint);
    if (!ref) return;
    const account = (log.args.account as string).toLowerCase();
    const payout = log.args.amount as bigint;
    await this.prisma.position.updateMany({
      where: { marketRef: ref, account },
      data: { redeemed: true, realizedPnl: { increment: dec(payout) } },
    });
    await this.prisma.market.update({ where: { id: ref }, data: { pot: { decrement: dec(payout) } } });
    await this.markets.invalidate(ref);
  }

  /// The creator reclaiming their locked seed. No position rows exist for it — the seed is
  /// deliberately never credited to the share ledger — so only the pot moves.
  private async onSeedRedeemed(log: NormalizedLog): Promise<void> {
    const ref = await this.marketRef(log.address, log.args.marketId as bigint);
    if (!ref) return;
    const amount = log.args.amount as bigint;
    if (amount === 0n) return;
    await this.prisma.market.update({ where: { id: ref }, data: { pot: { decrement: dec(amount) } } });
    await this.markets.invalidate(ref);
  }

  // ---- bonded resolution --------------------------------------------------
  //
  // These logs come from the resolver, so `log.address` is the resolver and `args.market` is the
  // engine. Everything below keys off `args.market`. Rows are upserted on (engine, marketId) and
  // carry the whole lifecycle, matching the chain's one-proposal-per-market shape.

  /** The engine + market id a resolution log is about, and the market row if we have indexed it. */
  private async resolutionKey(
    log: NormalizedLog,
  ): Promise<{ address: string; marketId: bigint; ref: string | null }> {
    const address = (log.args.market as string).toLowerCase();
    const marketId = log.args.marketId as bigint;
    // Deliberately tolerant: a resolution for a market we have not indexed yet is recorded anyway,
    // so the row is complete when the market catches up. Dropping it would lose the proposal.
    const market = await this.prisma.market.findUnique({
      where: { address_marketId: { address, marketId } },
      select: { id: true },
    });
    return { address, marketId, ref: market?.id ?? null };
  }

  private async onProposed(log: NormalizedLog): Promise<void> {
    const a = log.args;
    const { address, marketId, ref } = await this.resolutionKey(log);
    const data = {
      marketRef: ref,
      phase: ResolutionPhase.PROPOSED,
      proposer: (a.proposer as string).toLowerCase(),
      proposedOutcome: outcomeOrVoid(a.outcome),
      proposerBonded: a.bonded as boolean,
      proposerBond: dec(a.bond as bigint),
      disputeDeadline: new Date(Number(a.disputeDeadline) * 1000),
      // A previous cycle on this market may have been abandoned or unwound. Clearing the dispute
      // and settlement columns is what makes the row describe the *current* proposal rather than a
      // union of every attempt.
      disputer: null,
      counterOutcome: null,
      disputerBond: dec(0n),
      arbitrationDeadline: null,
      route: null,
      settledOutcome: null,
      reward: dec(0n),
      forfeited: dec(0n),
      loser: null,
      settledAt: null,
      settledTx: null,
      proposedTx: log.txHash,
    };
    await this.prisma.resolutionProposal.upsert({
      where: { address_marketId: { address, marketId } },
      create: { address, marketId, ...data },
      update: data,
    });
    await this.announceResolution(ref, address, marketId);
  }

  private async onDisputed(log: NormalizedLog): Promise<void> {
    const a = log.args;
    const { address, marketId, ref } = await this.resolutionKey(log);
    await this.prisma.resolutionProposal.updateMany({
      where: { address, marketId },
      data: {
        phase: ResolutionPhase.DISPUTED,
        disputer: (a.disputer as string).toLowerCase(),
        counterOutcome: outcomeOrVoid(a.counterOutcome),
        disputerBond: dec(a.bond as bigint),
        arbitrationDeadline: new Date(Number(a.arbitrationDeadline) * 1000),
      },
    });
    await this.announceResolution(ref, address, marketId);
  }

  private async onFinalized(log: NormalizedLog): Promise<void> {
    const a = log.args;
    const { address, marketId, ref } = await this.resolutionKey(log);
    await this.prisma.resolutionProposal.updateMany({
      where: { address, marketId },
      data: {
        phase: ResolutionPhase.SETTLED,
        route: ResolutionRoute.FINALIZED,
        settledOutcome: outcomeOrVoid(a.outcome),
        reward: dec(a.reward as bigint),
        settledAt: log.timestamp,
        settledTx: log.txHash,
      },
    });
    await this.announceResolution(ref, address, marketId);
  }

  private async onArbitrated(log: NormalizedLog): Promise<void> {
    const a = log.args;
    const { address, marketId, ref } = await this.resolutionKey(log);
    const loser = (a.loser as string).toLowerCase();
    await this.prisma.resolutionProposal.updateMany({
      where: { address, marketId },
      data: {
        phase: ResolutionPhase.SETTLED,
        route: ResolutionRoute.ARBITRATED,
        settledOutcome: outcomeOrVoid(a.outcome),
        reward: dec(a.reward as bigint),
        forfeited: dec(a.forfeited as bigint),
        // The zero address means there was nobody to punish: an overturned bond-free proposal.
        loser: loser === ZERO_ADDRESS ? null : loser,
      },
    });
    await this.announceResolution(ref, address, marketId);
  }

  /**
   * The forfeit itself. Recorded separately from {@link onArbitrated} because the ban may not have
   * landed — the resolver wraps it so a settlement is never blocked by the ban list refusing — and
   * `banned` is the only place that outcome is reported.
   */
  private async onSlashed(log: NormalizedLog): Promise<void> {
    const a = log.args;
    const { address, marketId } = await this.resolutionKey(log);
    await this.prisma.resolutionProposal.updateMany({
      where: { address, marketId },
      data: {
        loser: (a.account as string).toLowerCase(),
        forfeited: dec(a.amount as bigint),
        settledAt: log.timestamp,
        settledTx: log.txHash,
      },
    });
  }

  /** A stake came back without anything being settled: the market is open to proposals again. */
  private async onResolutionCleared(log: NormalizedLog): Promise<void> {
    const { address, marketId, ref } = await this.resolutionKey(log);
    await this.prisma.resolutionProposal.updateMany({
      where: { address, marketId },
      data: {
        phase: ResolutionPhase.NONE,
        proposer: null,
        proposedOutcome: null,
        proposerBonded: false,
        proposerBond: dec(0n),
        disputeDeadline: null,
        disputer: null,
        counterOutcome: null,
        disputerBond: dec(0n),
        arbitrationDeadline: null,
      },
    });
    await this.announceResolution(ref, address, marketId);
  }

  /** Push the new phase to anyone watching the market page. */
  private async announceResolution(
    ref: string | null,
    address: string,
    marketId: bigint,
  ): Promise<void> {
    // Nothing to announce for a market the indexer has not caught up to yet. The row is still
    // written; it simply has no subscribers and no cache entry to clear.
    if (!ref) return;
    await this.markets.invalidate(ref);
    await this.redis.del(`cache:markets:detail:${ref}`);
    const row = await this.prisma.resolutionProposal.findUnique({
      where: { address_marketId: { address, marketId } },
      select: { phase: true, disputeDeadline: true },
    });
    await this.publishMarket(ref, RealtimeEvent.Resolution, {
      phase: row?.phase ?? ResolutionPhase.NONE,
      disputeDeadline: row?.disputeDeadline?.toISOString() ?? null,
    });
  }

  // ---- the ban list -------------------------------------------------------

  private async onBanned(log: NormalizedLog): Promise<void> {
    const a = log.args;
    const account = (a.account as string).toLowerCase();
    const context = (a.context as string).toLowerCase();
    const data = {
      // Zero context means an operator banned directly, with no market behind it.
      context: context === ZERO_ADDRESS ? null : context,
      marketId: context === ZERO_ADDRESS ? null : (a.marketId as bigint),
      bannedAt: new Date(Number(a.at) * 1000),
      liftedAt: null,
      txHash: log.txHash,
    };
    await this.prisma.bannedAccount.upsert({
      where: { account },
      create: { account, ...data },
      update: data,
    });
  }

  /// Kept rather than deleted: that an account was once barred is part of the record, and the API
  /// filters on `liftedAt` rather than on the row existing.
  private async onUnbanned(log: NormalizedLog): Promise<void> {
    const account = (log.args.account as string).toLowerCase();
    await this.prisma.bannedAccount.updateMany({
      where: { account },
      data: { liftedAt: log.timestamp, txHash: log.txHash },
    });
  }

  // ---- price refresh ------------------------------------------------------

  private async refreshPrices(ref: string, logs: NormalizedLog[]): Promise<void> {
    const market = await this.prisma.market.findUnique({ where: { id: ref } });
    if (!market || !this.chain.isReady) return;
    let prices: bigint[];
    try {
      prices = await this.chain.readPrices(market.address as `0x${string}`, market.marketId);
    } catch (err) {
      this.logger.warn(`prices() read failed for ${ref}: ${(err as Error).message}`);
      return;
    }
    const ts = this.latestTs(logs, market.address, market.marketId);
    await this.applyPrices(ref, prices, ts);
  }

  private async applyPrices(ref: string, prices: bigint[], ts: Date): Promise<void> {
    await Promise.all(
      prices.map((p, i) =>
        this.prisma.outcome.update({
          where: { marketRef_index: { marketRef: ref, index: i } },
          data: { currentPriceWad: dec(p) },
        }),
      ),
    );
    await Promise.all(
      prices.map((p, i) =>
        this.prices.recordPoint({ marketRef: ref, outcomeIndex: i, priceWad: p, volume: 0n, timestamp: ts }),
      ),
    );
    await this.redis.del(`cache:markets:detail:${ref}`);
    await this.publishMarket(ref, RealtimeEvent.Price, {
      prices: prices.map((p) => p.toString()),
    });
  }

  // ---- shared helpers -----------------------------------------------------

  private latestTs(logs: NormalizedLog[], address: string, marketId: bigint): Date {
    let ts: Date | null = null;
    for (const l of logs) {
      if (l.address.toLowerCase() === address.toLowerCase() && (l.args.marketId as bigint) === marketId) {
        if (!ts || l.timestamp > ts) ts = l.timestamp;
      }
    }
    return ts ?? new Date();
  }

  private async insertTrade(
    log: NormalizedLog,
    marketRef: string,
    side: TradeSide,
    outcomeIndex: number,
    shares: bigint,
    amount: bigint,
    spreadWad: bigint,
    priceWad: bigint,
  ): Promise<void> {
    // Idempotent: unique on (txHash, logIndex). Duplicate logs (re-scan) are no-ops.
    await this.prisma.trade.upsert({
      where: { txHash_logIndex: { txHash: log.txHash, logIndex: log.logIndex } },
      update: {},
      create: {
        marketRef,
        engine: Engine.LS_LMSR,
        account: (log.args.account as string).toLowerCase(),
        side,
        outcomeIndex,
        shares: dec(shares),
        amount: dec(amount),
        spreadWad: dec(spreadWad),
        priceWad: dec(priceWad),
        blockNumber: log.blockNumber,
        txHash: log.txHash,
        logIndex: log.logIndex,
        timestamp: log.timestamp,
      },
    });
  }

  private async updatePosition(
    marketRef: string,
    rawAccount: string,
    outcomeIndex: number,
    side: TradeSide,
    shares: bigint,
    amount: bigint,
  ): Promise<void> {
    const account = rawAccount.toLowerCase();
    const existing = await this.prisma.position.findUnique({
      where: { marketRef_account_outcomeIndex: { marketRef, account, outcomeIndex } },
    });

    if (side === TradeSide.SELL) {
      const oldShares = existing ? BigInt(existing.shares.toString()) : 0n;
      const oldCost = existing ? BigInt(existing.costBasis.toString()) : 0n;
      const sold = shares > oldShares ? oldShares : shares;
      const costRemoved = oldShares > 0n ? (oldCost * sold) / oldShares : 0n;
      const realized = amount - costRemoved; // proceeds minus proportional basis
      await this.prisma.position.upsert({
        where: { marketRef_account_outcomeIndex: { marketRef, account, outcomeIndex } },
        create: {
          marketRef,
          account,
          outcomeIndex,
          shares: dec(0n),
          costBasis: dec(0n),
          realizedPnl: dec(realized),
        },
        update: {
          shares: { decrement: dec(sold) },
          costBasis: { decrement: dec(costRemoved) },
          realizedPnl: { increment: dec(realized) },
        },
      });
      return;
    }

    // Opening or adding: `amount` is what the trader actually paid, spread included.
    const addedCost = amount;
    await this.prisma.position.upsert({
      where: { marketRef_account_outcomeIndex: { marketRef, account, outcomeIndex } },
      create: {
        marketRef,
        account,
        outcomeIndex,
        shares: dec(shares),
        costBasis: dec(addedCost),
      },
      update: {
        shares: { increment: dec(shares) },
        costBasis: { increment: dec(addedCost) },
      },
    });
  }

  private async marketRef(rawAddress: string, marketId: bigint): Promise<string | null> {
    const address = rawAddress.toLowerCase();
    const key = `${address}:${marketId}`;
    const cached = this.refCache.get(key);
    if (cached) return cached;
    const market = await this.prisma.market.findUnique({
      where: { address_marketId: { address, marketId } },
      select: { id: true },
    });
    if (!market) {
      this.logger.warn(`event for unknown market ${key} — ignored`);
      return null;
    }
    this.refCache.set(key, market.id);
    return market.id;
  }

  private async publishMarket(ref: string, event: RealtimeEventName, data: unknown): Promise<void> {
    await this.publish(marketChannel(ref, event), event, data, ref);
  }

  private async publish(channel: string, event: RealtimeEventName, data: unknown, marketRef?: string): Promise<void> {
    const msg: RealtimeMessage = { event, marketRef, data, ts: Date.now() };
    await this.redis.publish(channel, msg);
  }
}
