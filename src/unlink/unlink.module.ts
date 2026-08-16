import { Module } from '@nestjs/common';
import { UnlinkController } from './unlink.controller';
import { UnlinkIdentityService } from './unlink-identity.service';
import { UnlinkService } from './unlink.service';

@Module({
  controllers: [UnlinkController],
  providers: [UnlinkService, UnlinkIdentityService],
  exports: [UnlinkService, UnlinkIdentityService],
})
export class UnlinkModule {}
