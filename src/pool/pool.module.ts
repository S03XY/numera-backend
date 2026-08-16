import { Module } from '@nestjs/common';
import { ChainModule } from '../chain/chain.module';
import { RelayModule } from '../relay/relay.module';
import { PoolController } from './pool.controller';
import { PoolIndexerService } from './pool-indexer.service';
import { PoolService } from './pool.service';

/**
 * Numera's own shielded pool.
 *
 * Depends on {RelayModule} rather than holding a key of its own, and that is not a shortcut. Two
 * services sending from one EOA race on the nonce, and the loser is dropped by the node with an
 * error that looks nothing like its cause. Every transaction this module sends therefore goes
 * through the one queue in `RelayService`, and inherits its simulation, its fee caps and its daily
 * spend ceiling for free.
 *
 * The leaf indexer is here rather than in {ChainModule} for the opposite reason: it must *not*
 * share the market indexer's cursor. See `pool-indexer.service.ts`.
 */
@Module({
  imports: [ChainModule, RelayModule],
  controllers: [PoolController],
  providers: [PoolService, PoolIndexerService],
  exports: [PoolService],
})
export class PoolModule {}
