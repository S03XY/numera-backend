import { Module, forwardRef } from '@nestjs/common';
import { MarketsModule } from '../markets/markets.module';
import { PricesModule } from '../prices/prices.module';
import { ChainService } from './chain.service';
import { EventProcessor } from './event-processor.service';
import { IndexerService } from './indexer.service';

/**
 * Chain integration: viem client, event processor, and the indexer loop that
 * mirrors on-chain state into Postgres and fans realtime updates out over Redis.
 */
@Module({
  imports: [forwardRef(() => MarketsModule), PricesModule],
  providers: [ChainService, EventProcessor, IndexerService],
  exports: [ChainService, EventProcessor],
})
export class ChainModule {}
