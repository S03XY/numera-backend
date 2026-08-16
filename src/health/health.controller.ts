import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ChainService } from '../chain/chain.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly chain: ChainService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness probe.' })
  live() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe: checks Postgres and Redis.' })
  async ready() {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    const healthy = db && redis;
    const body = {
      status: healthy ? 'ok' : 'degraded',
      checks: { database: db ? 'up' : 'down', redis: redis ? 'up' : 'down' },
      ts: new Date().toISOString(),
    };
    if (!healthy) throw new ServiceUnavailableException(body);
    return body;
  }

  /**
   * How far behind the chain the indexer is.
   *
   * Exposed because a lagging indexer is invisible from the outside: the API
   * keeps answering, every answer is simply old, and the product looks broken
   * rather than behind. A settled bet missing from a market for ten minutes is
   * indistinguishable from a bug unless something reports this number.
   */
  @Public()
  @Get('indexer')
  @ApiOperation({ summary: 'Indexer lag in blocks, and whether it is keeping up.' })
  async indexer() {
    const cursor = await this.prisma.indexerCursor.findUnique({ where: { stream: 'main' } });
    const head = this.chain.isReady ? await this.chain.getBlockNumber().catch(() => null) : null;

    const lastBlock = cursor ? Number(cursor.lastBlock) : null;
    const headBlock = head === null ? null : Number(head);
    const lag = lastBlock !== null && headBlock !== null ? headBlock - lastBlock : null;

    return {
      // A few blocks of lag is normal — the indexer deliberately trails the
      // unstable tip by `INDEXER_CONFIRMATIONS`. Hundreds means it has stalled.
      status: lag === null ? 'unknown' : lag <= 50 ? 'live' : lag <= 1_000 ? 'lagging' : 'stalled',
      lastBlock,
      headBlock,
      lag,
      updatedAt: cursor?.updatedAt?.toISOString() ?? null,
      ts: new Date().toISOString(),
    };
  }

  private async checkDb(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      const pong = await this.redis.client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }
}
