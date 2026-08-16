import { Module } from '@nestjs/common';
import { ChainModule } from '../chain/chain.module';
import { MarketsModule } from '../markets/markets.module';
// The relayer gauge is operator data, so it is served from the role-guarded controller here
// rather than from the public relay routes. `RelayModule` exports the service for exactly this.
import { RelayModule } from '../relay/relay.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAccessService } from './admin-access.service';
import { ProtocolRoleGuard } from './guards/protocol-role.guard';

@Module({
  imports: [ChainModule, MarketsModule, RelayModule],
  controllers: [AdminController],
  providers: [AdminService, AdminAccessService, ProtocolRoleGuard],
  exports: [AdminAccessService],
})
export class AdminModule {}
