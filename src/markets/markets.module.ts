import { Module, forwardRef } from '@nestjs/common';
import { ChainModule } from '../chain/chain.module';
import { MarketsController } from './markets.controller';
import { MarketsService } from './markets.service';
import { MarketSerializer } from './market.serializer';

/**
 * `forwardRef` because the two modules genuinely need each other, in opposite directions and for
 * different reasons: the indexer writes markets, and a market page reads live resolution terms off
 * the chain. Breaking the cycle would mean either splitting `ChainService` out from the indexer
 * that shares its client and its boot check, or duplicating the RPC setup — both worse than
 * declaring the cycle that is actually there.
 */
@Module({
  imports: [forwardRef(() => ChainModule)],
  controllers: [MarketsController],
  providers: [MarketsService, MarketSerializer],
  exports: [MarketsService, MarketSerializer],
})
export class MarketsModule {}
