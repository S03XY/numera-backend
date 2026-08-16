import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ResolutionPhase } from '@prisma/client';
import { encodeFunctionData } from 'viem';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { RelayService } from './relay.service';

/** The one call this service makes. Not in `RESOLUTION_SIGNATURES`, and see below for why. */
const FINALIZE_ABI = [
  {
    type: 'function',
    name: 'finalize',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'market', type: 'address' },
      { name: 'marketId', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/**
 * The step that turns a settled argument into money.
 *
 * ## The gap this closes
 *
 * A proposal that survives its challenge window is *not* settled. The resolver has recorded who
 * said what and when the window ended, but the engine has heard none of it: it still reports the
 * market as trading, still holds every share, and reverts every claim. One more transaction,
 * `finalize`, carries the result across, and the design left the sending of it to "anyone".
 *
 * Anyone turned out to be nobody. A market reached its deadline, went unchallenged, and simply
 * stopped there, with the winner looking at a position the product had no way to pay out and a
 * panel that told them somebody would be along shortly. The only hand on that lever was in the
 * admin console, which is not where a trader is standing.
 *
 * So the platform sends it. Settlement is not a favour a bystander does the winners; it is the last
 * step of the thing we sold them.
 *
 * ## Why this is safe to automate, and safe to leave open
 *
 * `finalize` pays the reward to the *recorded proposer* whoever broadcasts it, and refuses on any
 * proposal that is disputed, already settled, or still inside its window. So a keeper sending it
 * can take nothing, change nothing, and decide nothing. It also stays permissionless on chain: if
 * this service is down, a market is delayed rather than stuck, because anybody can still send it.
 *
 * It is deliberately not routed through the resolution forwarder. That forwarder exists so a market
 * account can act without holding gas, and its allowlist is the set of calls a *user* makes, priced
 * against the anonymity that gasless sending buys them. Nobody needs to be anonymous to press this.
 *
 * ## Why a poll rather than an event
 *
 * There is no event to listen for. Nothing happens on chain when a window expires; the deadline
 * simply passes. The indexer already writes that deadline into `ResolutionProposal`, so the
 * question "what is now finalizable" is a query against a table, asked on a timer.
 */
@Injectable()
export class SettlementService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SettlementService.name);

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  /**
   * Earliest next attempt per proposal, as epoch millis.
   *
   * Not a correctness guard — the chain is that, and a duplicate `finalize` reverts in simulation
   * for free. This is against noise: without it a proposal that cannot settle would be retried,
   * logged and simulated every twenty seconds forever, and the one line that mattered would be
   * buried under a thousand that did not.
   */
  private readonly nextAttempt = new Map<string, number>();
  private readonly attempts = new Map<string, number>();

  /** Long enough for the send to land and the indexer to move the row off `PROPOSED`. */
  private static readonly SETTLE_COOLDOWN_MS = 60_000;
  /** First backoff after a failure, doubling to {@link MAX_BACKOFF_MS}. */
  private static readonly BASE_BACKOFF_MS = 60_000;
  private static readonly MAX_BACKOFF_MS = 30 * 60_000;
  /** Per tick. A batch this size is already an incident; there is no rush to clear it in one pass. */
  private static readonly BATCH = 10;

  constructor(
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly relay: RelayService,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.settlement.enabled) {
      this.log.log('automatic settlement disabled — unchallenged proposals will need a manual finalize');
      return;
    }
    // Not gated on `relay.isEnabled` here. Provider init order puts the relay's boot check before
    // this, but a service that silently never starts because of an ordering detail is the kind of
    // thing that is discovered by a user, so the check is done per tick instead.
    this.schedule(this.cfg.settlement.pollIntervalMs);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      if (this.relay.isEnabled) await this.settleDue();
    } catch (err) {
      // Never let one bad pass end the loop: this runs unattended and the next pass is free.
      this.log.error('settlement pass failed', err as Error);
    }
    this.schedule(this.cfg.settlement.pollIntervalMs);
  }

  /** One pass: everything whose window has closed, minus what is in backoff. */
  private async settleDue(): Promise<void> {
    const resolver = this.cfg.chain.addresses.optimisticResolver;
    if (!resolver) return;

    const due = await this.prisma.resolutionProposal.findMany({
      where: {
        phase: ResolutionPhase.PROPOSED,
        // Null means the indexer has not written a deadline yet, which is not the same as a window
        // that has closed. Prisma treats `lt` on a nullable column as excluding nulls, which is
        // what we want, but it is worth being explicit about relying on it.
        disputeDeadline: { not: null, lt: new Date() },
      },
      orderBy: { disputeDeadline: 'asc' },
      take: SettlementService.BATCH,
      select: { address: true, marketId: true, marketRef: true },
    });

    const now = Date.now();
    for (const p of due) {
      const key = `${p.address}:${p.marketId}`;
      if ((this.nextAttempt.get(key) ?? 0) > now) continue;
      await this.finalize(resolver as `0x${string}`, p.address, p.marketId, key, p.marketRef);
    }
  }

  private async finalize(
    resolver: `0x${string}`,
    engine: string,
    marketId: bigint,
    key: string,
    marketRef: string | null,
  ): Promise<void> {
    const data = encodeFunctionData({
      abi: FINALIZE_ABI,
      functionName: 'finalize',
      args: [engine as `0x${string}`, marketId],
    });

    // Booked before the attempt, not after. An exception between sending and recording would
    // otherwise leave the cooldown unset on a transaction that is already in flight, and the next
    // tick would send a second one.
    this.nextAttempt.set(key, Date.now() + SettlementService.SETTLE_COOLDOWN_MS);

    let hash: `0x${string}`;
    try {
      hash = await this.relay.sendFromRelayer(resolver, data, `finalize market ${marketId}`);
    } catch (err) {
      this.backOff(key, err);
      return;
    }

    this.attempts.delete(key);
    this.log.log(`settling market ${marketId}${marketRef ? ` (${marketRef})` : ''} — ${hash}`);

    // Awaited outside the nonce queue, so a slow block never holds up somebody's trade. A missing
    // receipt is not a failure: the transaction may still be pending, and the next pass will find
    // the proposal again if it never lands.
    const receipt = await this.relay.receiptFor(hash);
    if (receipt?.status === 'reverted') {
      this.log.error(`finalize for market ${marketId} reverted on chain — ${hash}`);
      this.backOff(key);
    }
  }

  /** Back off further each time, so a proposal that can never settle costs a line every half hour. */
  private backOff(key: string, err?: unknown): void {
    const n = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, n);
    const delay = Math.min(
      SettlementService.BASE_BACKOFF_MS * 2 ** (n - 1),
      SettlementService.MAX_BACKOFF_MS,
    );
    this.nextAttempt.set(key, Date.now() + delay);

    const reason = err instanceof Error ? err.message : String(err ?? 'reverted');
    const line = `could not settle ${key} (attempt ${n}, retrying in ${Math.round(delay / 1000)}s): ${reason}`;
    // The first couple of failures are ordinary — a proposal disputed in the same second, a node
    // hiccup. A run of them is an outage, and reads as one.
    if (n <= 2) this.log.warn(line);
    else this.log.error(line);
  }
}
