import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ChainModule } from '../chain/chain.module';

// ChainModule for the live head, so `/health/indexer` can report real lag
// rather than only how far the cursor happens to have got.
@Module({
  imports: [ChainModule],
  controllers: [HealthController],
})
export class HealthModule {}
