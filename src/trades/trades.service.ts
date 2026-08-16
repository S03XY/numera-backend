import { Injectable } from '@nestjs/common';
import { Prisma, Trade } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Paginated, PaginationDto, paginate } from '../common/dto/pagination.dto';
import { normalizeAddress } from '../common/utils/address';
import { toStr } from '../common/utils/decimal';

export interface TradeView {
  id: string;
  marketRef: string;
  engine: Trade['engine'];
  side: Trade['side'];
  account: string; // execution account — pseudonymous
  outcomeIndex: number;
  shares: string;
  amount: string;
  /** Spread applied to this trade (WAD). */
  spreadWad: string;
  priceWad: string;
  txHash: string;
  blockNumber: string;
  timestamp: string;
}

function serialize(t: Trade): TradeView {
  return {
    id: t.id,
    marketRef: t.marketRef,
    engine: t.engine,
    side: t.side,
    account: t.account,
    outcomeIndex: t.outcomeIndex,
    shares: toStr(t.shares)!,
    amount: toStr(t.amount)!,
    spreadWad: toStr(t.spreadWad)!,
    priceWad: toStr(t.priceWad)!,
    txHash: t.txHash,
    blockNumber: t.blockNumber.toString(),
    timestamp: t.timestamp.toISOString(),
  };
}

@Injectable()
export class TradesService {
  constructor(private readonly prisma: PrismaService) {}

  async listByMarket(marketRef: string, dto: PaginationDto): Promise<Paginated<TradeView>> {
    const where: Prisma.TradeWhereInput = { marketRef };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.trade.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: dto.offset,
        take: dto.limit,
      }),
      this.prisma.trade.count({ where }),
    ]);
    return paginate(rows.map(serialize), total, dto);
  }

  async listByAccount(account: string, dto: PaginationDto): Promise<Paginated<TradeView>> {
    const where: Prisma.TradeWhereInput = { account: normalizeAddress(account) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.trade.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: dto.offset,
        take: dto.limit,
      }),
      this.prisma.trade.count({ where }),
    ]);
    return paginate(rows.map(serialize), total, dto);
  }

  /** Most recent trades across all markets (global tape). */
  async recent(dto: PaginationDto): Promise<Paginated<TradeView>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.trade.findMany({
        orderBy: { timestamp: 'desc' },
        skip: dto.offset,
        take: dto.limit,
      }),
      this.prisma.trade.count(),
    ]);
    return paginate(rows.map(serialize), total, dto);
  }
}
