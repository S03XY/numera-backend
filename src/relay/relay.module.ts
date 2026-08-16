import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { RelayController } from './relay.controller';
import { RelayService } from './relay.service';
import { SettlementService } from './settlement.service';

/**
 * Sponsored execution for market accounts, so they never hold — or need — native gas.
 *
 * {@link SettlementService} belongs here rather than beside the indexer because it sends from the
 * relayer's key, and everything that sends from that key has to share one nonce queue.
 */
@Module({
  imports: [RedisModule],
  controllers: [RelayController],
  providers: [RelayService, SettlementService],
  exports: [RelayService],
})
export class RelayModule {}
