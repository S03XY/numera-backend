import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MarketStatus, Prisma, ResolutionPhase, ResolutionProposal } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MarketsService } from '../markets/markets.service';
import { ChainService } from '../chain/chain.service';
import { AppConfigService } from '../config/app-config.service';
import { toStr } from '../common/utils/decimal';
import { CreateMetadataDraftDto, UpsertCategoryDto } from './dto/admin.dto';
import { canonicalize, metadataHashOf } from './metadata-hash';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly markets: MarketsService,
    private readonly chain: ChainService,
    private readonly cfg: AppConfigService,
  ) {}

  // ----------------------------------------------------------- metadata ----

  /**
   * Step 1 of market creation: store the copy and return the `metadataHash` to
   * pass to `createMarket(...)` on-chain. Re-drafting identical content is
   * idempotent (same hash), so a retried request never creates a duplicate.
   */
  async createDraft(dto: CreateMetadataDraftDto, createdBy: string) {
    const canonical = {
      title: dto.title,
      description: dto.description ?? '',
      resolutionRules: dto.resolutionRules,
      imageUrl: dto.imageUrl ?? null,
      outcomeLabels: dto.outcomeLabels,
      categoryKey: dto.categoryKey ?? null,
    };
    const metadataHash = metadataHashOf(canonical);

    await this.prisma.marketMetadataDraft.upsert({
      where: { metadataHash },
      create: { metadataHash, ...canonical, createdBy: createdBy.toLowerCase() },
      update: {},
    });

    return {
      metadataHash,
      canonical: canonicalize(canonical),
      ...canonical,
      note: 'Pass metadataHash as the metadataHash argument to createMarket(). The indexer adopts this copy when the on-chain event carries the same hash.',
    };
  }

  async listDrafts(limit = 50) {
    const rows = await this.prisma.marketMetadataDraft.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((d) => ({
      metadataHash: d.metadataHash,
      title: d.title,
      outcomeLabels: d.outcomeLabels,
      categoryKey: d.categoryKey,
      adopted: d.marketRef !== null,
      marketRef: d.marketRef,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  /** Edit an existing market's copy. Never touches on-chain economic parameters. */
  /*
    There is deliberately no `updateMarketMetadata` here any more.

    Everything a market says about itself — its title, its description, its outcome labels and above
    all its resolution rules — is inside `metadataHash`, which the engine stores immutably at
    creation and publishes in full in `MarketMetadataPublished`. Editing any of it here would leave
    us serving text that no longer hashes to what the market committed to, which quietly destroys
    the one property that makes the commitment worth anything: that a reader can re-encode what we
    serve, hash it, and confirm it is what they bet against.

    The rules were already excluded for exactly that reason. The rest followed once the whole
    metadata string went on chain — there is no longer a "presentation" half that is safe to move.

    A market with the wrong copy is therefore not edited, it is replaced: create a new one. That is
    a real cost and it is the correct one, because the alternative is settlement criteria that can
    be reworded after people have taken positions against them.

    The indexer adopts copy from `MarketMetadataPublished`; see `chain/event-processor.service.ts`.
  */

  // --------------------------------------------------------- categories ----

  async upsertCategory(dto: UpsertCategoryDto) {
    return this.prisma.category.upsert({
      where: { key: dto.key },
      create: { key: dto.key, label: dto.label, enabled: dto.enabled ?? true },
      update: { label: dto.label, enabled: dto.enabled ?? undefined },
    });
  }

  async listAllCategories() {
    return this.prisma.category.findMany({ orderBy: { key: 'asc' } });
  }

  // ----------------------------------------------------------- treasury ----

  /**
   * Engine status, read live from chain.
   *
   * There is no accrued-fee balance to report any more: the engine sweeps each market's surplus
   * to the fee recipient at resolution rather than holding it, so the contract never carries a
   * pending-withdrawal balance. What an operator needs here is where that surplus goes and
   * whether trading is halted.
   */
  async treasury() {
    const { addresses, collateralDecimals } = this.cfg.chain;
    const token = addresses.usdc;
    const engines: { name: string; address: string }[] = [];
    if (addresses.lsLmsr) engines.push({ name: 'LS_LMSR', address: addresses.lsLmsr });

    if (!this.chain.isReady || !token) {
      return {
        available: false,
        reason: 'chain RPC or USDC address not configured',
        collateral: token,
        collateralDecimals,
        engines: engines.map((e) => ({ ...e, feeRecipient: null, paused: null })),
      };
    }

    const rows = await Promise.all(
      engines.map(async (e) => {
        try {
          const [feeRecipient, paused] = await Promise.all([
            this.chain.readFeeRecipient(e.address as `0x${string}`),
            this.chain.readPaused(e.address as `0x${string}`).catch(() => null),
          ]);
          return { ...e, feeRecipient, paused };
        } catch (err) {
          this.logger.warn(`treasury read failed for ${e.name}: ${(err as Error).message}`);
          return { ...e, feeRecipient: null, paused: null, error: 'read failed' };
        }
      }),
    );

    return {
      available: true,
      collateral: token,
      collateralDecimals,
      engines: rows,
      note: 'Withdraw by calling withdrawFees(token, to, amount) from a FEE_MANAGER_ROLE holder.',
    };
  }

  // ------------------------------------------------------ operations queue --

  /**
   * Everything needing operator attention, in the three shapes it actually arrives in.
   *
   * Nothing here is signed by this server. Proposing is signed by an operator wallet holding
   * `RESOLVER_ROLE`, arbitration by the quorum. All this does is say what is waiting and how
   * urgent it is, because the alternative is an operator watching the chain by hand.
   *
   * The three queues are genuinely different jobs:
   *
   *  - **awaitingProposal** — closed, nobody has said anything. No deadline exists, so this grows
   *    quietly and is the one that gets forgotten.
   *  - **disputed** — somebody staked against a standing proposal. Only the quorum can clear it,
   *    and if it does not, `resetStuckDispute` unwinds both bonds and the market is back to square
   *    one. That timeout is the reason `arbitrationDeadline` is surfaced.
   *  - **finalizable** — the window passed unchallenged. Anyone at all can settle these, including
   *    a passer-by, but until somebody does the winners cannot claim.
   */
  async operationsQueue() {
    const now = new Date();

    const [awaiting, live] = await Promise.all([
      this.prisma.market.findMany({
        where: {
          status: MarketStatus.TRADING,
          closeTime: { lt: now },
          // A market with a live proposal is not waiting on anybody, so it belongs to one of the
          // other two queues instead. `is: null` catches markets the resolver has never touched.
          OR: [{ resolution: { is: null } }, { resolution: { phase: ResolutionPhase.NONE } }],
        },
        orderBy: { closeTime: 'asc' },
        take: 100,
        select: this.queueSelect,
      }),
      this.prisma.resolutionProposal.findMany({
        where: { phase: { in: [ResolutionPhase.PROPOSED, ResolutionPhase.DISPUTED] } },
        orderBy: { disputeDeadline: 'asc' },
        take: 200,
        include: { market: { select: this.queueSelect } },
      }),
    ]);

    const disputed = live
      .filter((r) => r.phase === ResolutionPhase.DISPUTED)
      .map((r) => this.queueRow(r));
    // "The window has passed" is not the same as "settled": the chain still needs somebody to call
    // `finalize`, and until they do the winners cannot claim.
    const finalizable = live
      .filter((r) => r.phase === ResolutionPhase.PROPOSED && (r.disputeDeadline?.getTime() ?? 0) < now.getTime())
      .map((r) => this.queueRow(r));

    return {
      awaitingProposal: awaiting.map((m) => this.marketRow(m)),
      disputed,
      finalizable,
      counts: {
        awaitingProposal: awaiting.length,
        disputed: disputed.length,
        finalizable: finalizable.length,
      },
    };
  }

  /** The market fields every queue row needs. One definition, so the three queues cannot drift. */
  private readonly queueSelect = {
    id: true,
    title: true,
    engine: true,
    address: true,
    marketId: true,
    closeTime: true,
    resolver: true,
    outcomeCount: true,
    pot: true,
  } as const;

  private marketRow(m: {
    id: string;
    title: string;
    engine: string;
    address: string;
    marketId: bigint;
    closeTime: Date;
    resolver: string;
    outcomeCount: number;
    pot: Prisma.Decimal;
  }) {
    return {
      id: m.id,
      title: m.title,
      engine: m.engine,
      address: m.address,
      marketId: m.marketId.toString(),
      closeTime: m.closeTime.toISOString(),
      resolver: m.resolver,
      outcomeCount: m.outcomeCount,
      pot: toStr(m.pot),
    };
  }

  /**
   * A queue row for a market that has a live proposal on it.
   *
   * `market` can be null: a proposal indexed before the market it is about keeps a null
   * `marketRef` until the market stream catches up. The row is still shown, because a disputed
   * market the operator cannot see is worse than one with a missing title.
   */
  private queueRow(r: ResolutionProposal & { market: Parameters<AdminService['marketRow']>[0] | null }) {
    return {
      ...(r.market
        ? this.marketRow(r.market)
        : {
            id: null,
            title: '(market not yet indexed)',
            address: r.address,
            marketId: r.marketId.toString(),
          }),
      phase: r.phase,
      proposer: r.proposer,
      proposedOutcome: r.proposedOutcome,
      proposerBonded: r.proposerBonded,
      proposerBond: toStr(r.proposerBond),
      disputer: r.disputer,
      counterOutcome: r.counterOutcome,
      disputerBond: toStr(r.disputerBond),
      disputeDeadline: r.disputeDeadline?.toISOString() ?? null,
      arbitrationDeadline: r.arbitrationDeadline?.toISOString() ?? null,
    };
  }
}
