import { Injectable } from '@nestjs/common';
import { Market, Outcome, Position } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeAddress } from '../common/utils/address';
import { toStr } from '../common/utils/decimal';

type PositionWithMarket = Position & { market: Market & { outcomes: Outcome[] } };

export interface PositionView {
  marketRef: string;
  marketTitle: string;
  marketStatus: Market['status'];
  engine: Market['engine'];
  /**
   * On-chain coordinates of the market.
   *
   * Carried on the position because claiming is built entirely client-side: the
   * browser encodes `redeem(marketId)` / `claim(marketId)` against the engine
   * contract and sends it from its own execution account. Without these it would
   * have to re-fetch every market just to build the call.
   */
  marketAddress: string;
  /** The engine's own market id (uint256 as a decimal string). */
  marketOnChainId: string;
  /** Collateral token — the asset swept back into the shielded pool on claim. */
  collateral: string;
  account: string;
  outcomeIndex: number;
  outcomeLabel: string;
  shares: string;
  costBasis: string;
  realizedPnl: string;
  redeemed: boolean;
  currentPriceWad: string | null;
  winningOutcomeId: number | null;
  /** Best-effort mark-to-market in collateral base units (null if not derivable). */
  markToMarket: string | null;
}

/**
 * What a position is worth right now, in collateral base units.
 *
 * Every branch is exact rather than an estimate, because the portfolio screen renders this as
 * "you won X" and a hedged number there is worse than no number.
 */
function markToMarket(p: PositionWithMarket, outcome: Outcome | undefined): string | null {
  const shares = BigInt(p.shares.toString());
  if (shares === 0n) return '0';

  if (p.market.status === 'RESOLVED') {
    // Winning shares redeem 1:1 and losing shares are worthless — no pro-rata split, because
    // the engine reserves the full winning liability at resolution rather than dividing a pot.
    return p.outcomeIndex === p.market.winningOutcomeId ? shares.toString() : '0';
  }

  if (p.market.status === 'INVALID') {
    // Everyone refunds their cost basis.
    return toStr(p.costBasis);
  }

  // Open market: mark at the live price, which is in WAD and always within [0, 1].
  if (outcome) {
    const priceWad = BigInt(outcome.currentPriceWad.toString());
    return ((shares * priceWad) / 10n ** 18n).toString();
  }
  return null;
}

@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService) {}

  private serialize(p: PositionWithMarket): PositionView {
    const outcome = p.market.outcomes.find((o) => o.index === p.outcomeIndex);
    return {
      marketRef: p.marketRef,
      marketTitle: p.market.title,
      marketStatus: p.market.status,
      engine: p.market.engine,
      marketAddress: p.market.address,
      marketOnChainId: p.market.marketId.toString(),
      collateral: p.market.collateral,
      account: p.account,
      outcomeIndex: p.outcomeIndex,
      outcomeLabel: outcome?.label ?? '',
      shares: toStr(p.shares)!,
      costBasis: toStr(p.costBasis)!,
      realizedPnl: toStr(p.realizedPnl)!,
      redeemed: p.redeemed,
      currentPriceWad: outcome ? toStr(outcome.currentPriceWad) : null,
      winningOutcomeId: p.market.winningOutcomeId,
      markToMarket: markToMarket(p, outcome),
    };
  }

  /** Portfolio: positions across all markets for a set of execution accounts. */
  async forAccounts(rawAccounts: string[]): Promise<PositionView[]> {
    const accounts = [...new Set(rawAccounts.map(normalizeAddress))];
    const rows = await this.prisma.position.findMany({
      where: { account: { in: accounts }, shares: { gt: 0 } },
      include: { market: { include: { outcomes: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  /** Positions of a single account within one market. */
  async forMarketAccount(marketRef: string, rawAccount: string): Promise<PositionView[]> {
    const account = normalizeAddress(rawAccount);
    const rows = await this.prisma.position.findMany({
      where: { marketRef, account },
      include: { market: { include: { outcomes: true } } },
      orderBy: { outcomeIndex: 'asc' },
    });
    return rows.map((r) => this.serialize(r));
  }
}
