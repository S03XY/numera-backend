import { Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ChainService } from '../chain/chain.service';
import { AppConfigService } from '../config/app-config.service';
import { Paginated, paginate } from '../common/dto/pagination.dto';
import { toHuman } from '../common/utils/decimal';
import { ListMarketsDto, MarketSort } from './dto/list-markets.dto';
import { MarketSerializer, MarketView } from './market.serializer';

const LIST_TTL = 3; // seconds — short: prices move, WS carries live updates
const DETAIL_TTL = 2;

/**
 * What it costs to take part in settling a market, right now.
 *
 * `available: false` means the resolver is not configured or unreachable — the market still
 * settles, through the operator, and the UI should say so rather than show an error.
 */
export type ResolutionTermsView =
  | { available: false }
  | {
      available: true;
      resolver: string;
      bond: string;
      bondHuman: string | null;
      fee: string;
      feeHuman: string | null;
      reward: string;
      rewardHuman: string | null;
      disputeWindowSeconds: number;
      rewardPool: string;
      rewardPoolHuman: string | null;
    };

@Injectable()
export class MarketsService {
  private readonly logger = new Logger(MarketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly serializer: MarketSerializer,
    // Explicit `@Inject` with the same forwardRef the module declares: without it Nest resolves the
    // token while `ChainModule` is still half-built and injects `undefined`, which surfaces much
    // later as "cannot read isReady of undefined" on the first market page load.
    @Inject(forwardRef(() => ChainService)) private readonly chain: ChainService,
    private readonly cfg: AppConfigService,
  ) {}

  private listKey(dto: ListMarketsDto): string {
    return `cache:markets:list:${JSON.stringify(dto)}`;
  }
  private detailKey(id: string): string {
    return `cache:markets:detail:${id}`;
  }

  async list(dto: ListMarketsDto): Promise<Paginated<MarketView>> {
    return this.redis.wrap(this.listKey(dto), LIST_TTL, async () => {
      const where: Prisma.MarketWhereInput = {};
      if (dto.status) where.status = dto.status;
      if (dto.engine) where.engine = dto.engine;
      if (dto.category) where.categoryKey = dto.category;
      if (dto.search) where.title = { contains: dto.search, mode: 'insensitive' };
      if (dto.openOnly) {
        where.status = 'TRADING';
        where.closeTime = { gt: new Date() };
      }

      const orderBy = this.orderBy(dto.sort, dto.order);

      const [rows, total] = await this.prisma.$transaction([
        this.prisma.market.findMany({
          where,
          orderBy,
          skip: dto.offset,
          take: dto.limit,
          include: { outcomes: true, resolution: true },
        }),
        this.prisma.market.count({ where }),
      ]);

      const items = rows.map((r) => this.serializer.market(r));
      return paginate(items, total, dto);
    });
  }

  async getById(id: string): Promise<MarketView> {
    const cached = await this.redis.getJson<MarketView>(this.detailKey(id));
    if (cached) return cached;

    const market = await this.prisma.market.findUnique({
      where: { id },
      include: { outcomes: true, resolution: true },
    });
    if (!market) throw new NotFoundException('market not found');

    const view = this.serializer.market(market);
    await this.redis.setJson(this.detailKey(id), view, DETAIL_TTL);
    return view;
  }

  /** Lookup by on-chain identity (engine contract address + marketId). */
  async getByChainId(address: string, marketId: bigint): Promise<MarketView> {
    const market = await this.prisma.market.findUnique({
      where: { address_marketId: { address: address.toLowerCase(), marketId } },
      include: { outcomes: true, resolution: true },
    });
    if (!market) throw new NotFoundException('market not found');
    return this.serializer.market(market);
  }

  /**
   * What proposing or disputing this market costs right now, read from the resolver.
   *
   * Never cached and never mirrored into the database. The bond scales with the pot and the reward
   * with the fees the market has earned, so both move on every trade; a stored figure would be a
   * quote we cannot honour by the time anyone acted on it.
   *
   * Returns `available: false` rather than throwing when the resolver is not configured. A market
   * page should degrade to "settlement is handled by the operator" instead of erroring.
   */
  async resolutionTerms(id: string): Promise<ResolutionTermsView> {
    const market = await this.prisma.market.findUnique({
      where: { id },
      select: { address: true, marketId: true },
    });
    if (!market) throw new NotFoundException('market not found');

    const resolver = this.cfg.chain.addresses.optimisticResolver;
    if (!resolver || !this.chain.isReady) return { available: false };

    try {
      const t = await this.chain.readResolutionTerms(
        resolver,
        market.address as `0x${string}`,
        market.marketId,
      );
      const decimals = this.cfg.chain.collateralDecimals;
      return {
        available: true,
        resolver,
        bond: t.bond.toString(),
        bondHuman: toHuman(t.bond, decimals),
        fee: t.fee.toString(),
        feeHuman: toHuman(t.fee, decimals),
        reward: t.reward.toString(),
        rewardHuman: toHuman(t.reward, decimals),
        disputeWindowSeconds: t.disputeWindowSeconds,
        // Surfaced because a reward is only real if the pool can pay it. A trader deciding whether
        // to stake deserves to see that the money is actually there.
        rewardPool: t.rewardPool.toString(),
        rewardPoolHuman: toHuman(t.rewardPool, decimals),
      };
    } catch (err) {
      this.logger.warn(`resolution terms read failed for ${id}: ${(err as Error).message}`);
      return { available: false };
    }
  }

  async listCategories() {
    return this.prisma.category.findMany({
      where: { enabled: true },
      orderBy: { label: 'asc' },
    });
  }

  /** Called by the indexer after mutating a market so stale caches are dropped. */
  async invalidate(marketRef: string): Promise<void> {
    await Promise.all([
      this.redis.del(this.detailKey(marketRef)),
      this.redis.delPattern('cache:markets:list:*'),
    ]);
  }

  private orderBy(sort: MarketSort, order: 'asc' | 'desc'): Prisma.MarketOrderByWithRelationInput {
    switch (sort) {
      case MarketSort.CloseTime:
        return { closeTime: order };
      case MarketSort.Pot:
        return { pot: order };
      case MarketSort.CreatedAt:
      default:
        return { createdAt: order };
    }
  }
}
