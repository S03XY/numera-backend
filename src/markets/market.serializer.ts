import { Injectable } from '@nestjs/common';
import { Market, Outcome, ResolutionProposal } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';
import { toHuman, toStr, wadToProbability } from '../common/utils/decimal';

export type MarketWithOutcomes = Market & {
  outcomes: Outcome[];
  resolution?: ResolutionProposal | null;
};

export interface OutcomeView {
  index: number;
  label: string;
  priceWad: string | null;
  probability: string | null; // 0..1
  shares: string | null;
}

/**
 * Where a market's settlement has got to.
 *
 * PRIVACY: `proposer`, `disputer` and `loser` are market execution accounts — the same shielded
 * addresses that appear on trades — never login wallets. They are public on chain already, and
 * showing them is what lets a trader verify the record rather than take our word for it.
 *
 * The bond and reward figures here are historical: what was actually staked and paid. What it would
 * cost to propose *now* moves with the book and is a separate, live read — see the terms endpoint.
 */
export interface ResolutionView {
  phase: ResolutionProposal['phase'];
  /** The standing assertion, or null when it is "void this market". */
  proposedOutcome: number | null;
  proposer: string | null;
  /** False for an operator's bond-free proposal: nothing staked, so nothing to forfeit. */
  bonded: boolean;
  bond: string | null;
  disputeDeadline: string | null;
  /** Whether the window is open right now, so the UI does not have to do date arithmetic. */
  disputable: boolean;
  /** Whether anyone may settle it now. Deliberately not the same as "the window has passed". */
  finalizable: boolean;
  disputer: string | null;
  counterOutcome: number | null;
  disputerBond: string | null;
  arbitrationDeadline: string | null;
  route: ResolutionProposal['route'];
  settledOutcome: number | null;
  reward: string | null;
  forfeited: string | null;
  /** The account that staked on a false outcome, lost it, and was barred from trading. */
  loser: string | null;
  settledAt: string | null;
}

export interface MarketView {
  id: string;
  engine: Market['engine'];
  address: string;
  marketId: string;
  title: string;
  description: string;
  imageUrl: string | null;
  category: string | null;
  status: Market['status'];
  tradingOpen: boolean;
  /**
   * How this market settles, as published at creation and committed to `metadataHash`.
   *
   * Empty only for markets created before rules existed. Anyone can re-encode what this endpoint
   * serves and check the hash against the chain, which is what makes it a commitment.
   */
  resolutionRules: string;
  /**
   * When betting opens, enforced on chain.
   *
   * Always present — the engine substitutes the creation timestamp when a creator does not name
   * one — so a market that opened immediately reports a start time in the past rather than null.
   * The UI compares it rather than checking for absence.
   */
  startTime: string;
  /** True while the clock is before {@link startTime}. A trade now reverts with `MarketNotOpenYet`. */
  notOpenYet: boolean;
  closeTime: string;
  winningOutcomeId: number | null;
  collateral: string;
  collateralDecimals: number;
  /** Liquidity coefficient (WAD), immutable on-chain. */
  alpha: string | null;
  /** Damping scale (WAD), immutable on-chain. */
  sStar: string | null;
  /** Shares of every outcome the creator seeded, locked until resolution. */
  seed: string | null;
  /** Collateral the market holds. Always >= the largest possible payout. */
  pot: string;
  potHuman: string | null;
  /** Swept to the fee recipient at settlement; null until then. */
  surplus: string | null;
  outcomeCount: number;
  outcomes: OutcomeView[];
  /**
   * Null when the market has never been through the resolution layer — which is every market that
   * is still trading, so the UI treats null as "nothing to show yet" rather than an error.
   */
  resolution: ResolutionView | null;
  createdAt: string;
}

/** Maps DB rows to the public API shape (formats amounts, prices, open state). */
@Injectable()
export class MarketSerializer {
  constructor(private readonly cfg: AppConfigService) {}

  private get decimals(): number {
    return this.cfg.chain.collateralDecimals;
  }

  /**
   * Whether a trade would be accepted right now.
   *
   * Both ends of the window, because the engine enforces both: `_tradable` reverts before
   * `startTime` with `MarketNotOpenYet` and after `closeTime` with the close check. A UI that
   * offered a bet on a scheduled market would produce a signed trade that cannot land, and the
   * revert names a condition the trader was never shown.
   */
  isTradingOpen(m: Market): boolean {
    const now = Date.now();
    return m.status === 'TRADING' && m.startTime.getTime() <= now && m.closeTime.getTime() > now;
  }

  /** Scheduled, but not open yet. Distinct from closed, and the UI says so differently. */
  isNotOpenYet(m: Market): boolean {
    return m.status === 'TRADING' && m.startTime.getTime() > Date.now();
  }

  outcome(o: Outcome): OutcomeView {
    return {
      index: o.index,
      label: o.label,
      priceWad: toStr(o.currentPriceWad),
      probability: wadToProbability(o.currentPriceWad),
      shares: toStr(o.currentShares),
    };
  }

  /**
   * A market past its close time with nothing proposed on it.
   *
   * There is deliberately no deadline on proposing, so this state can persist indefinitely and is
   * the operations queue's whole reason to exist.
   */
  isAwaitingProposal(m: MarketWithOutcomes): boolean {
    return (
      m.status === 'TRADING' &&
      m.closeTime.getTime() <= Date.now() &&
      (m.resolution == null || m.resolution.phase === 'NONE')
    );
  }

  resolution(r: ResolutionProposal | null | undefined): ResolutionView | null {
    if (!r) return null;
    const now = Date.now();
    const deadline = r.disputeDeadline?.getTime() ?? 0;
    return {
      phase: r.phase,
      proposedOutcome: r.proposedOutcome,
      proposer: r.proposer,
      bonded: r.proposerBonded,
      bond: toStr(r.proposerBond),
      disputeDeadline: r.disputeDeadline?.toISOString() ?? null,
      disputable: r.phase === 'PROPOSED' && now <= deadline,
      // A proposal whose window has passed is NOT settled until somebody calls `finalize`. Reporting
      // it as settled early would tell a trader their money is claimable when the chain disagrees.
      finalizable: r.phase === 'PROPOSED' && now > deadline,
      disputer: r.disputer,
      counterOutcome: r.counterOutcome,
      disputerBond: toStr(r.disputerBond),
      arbitrationDeadline: r.arbitrationDeadline?.toISOString() ?? null,
      route: r.route,
      settledOutcome: r.settledOutcome,
      reward: toStr(r.reward),
      forfeited: toStr(r.forfeited),
      loser: r.loser,
      settledAt: r.settledAt?.toISOString() ?? null,
    };
  }

  market(m: MarketWithOutcomes): MarketView {
    return {
      id: m.id,
      engine: m.engine,
      address: m.address,
      marketId: m.marketId.toString(),
      title: m.title,
      description: m.description,
      imageUrl: m.imageUrl,
      category: m.categoryKey,
      status: m.status,
      tradingOpen: this.isTradingOpen(m),
      resolutionRules: m.resolutionRules,
      startTime: m.startTime.toISOString(),
      notOpenYet: this.isNotOpenYet(m),
      closeTime: m.closeTime.toISOString(),
      winningOutcomeId: m.winningOutcomeId,
      collateral: m.collateral,
      collateralDecimals: this.decimals,
      alpha: toStr(m.alpha),
      sStar: toStr(m.sStar),
      seed: toStr(m.seed),
      pot: m.pot.toString(),
      potHuman: toHuman(m.pot, this.decimals),
      surplus: toStr(m.surplus),
      outcomeCount: m.outcomeCount,
      outcomes: [...m.outcomes].sort((a, b) => a.index - b.index).map((o) => this.outcome(o)),
      resolution: this.resolution(m.resolution),
      createdAt: m.createdAt.toISOString(),
    };
  }
}
