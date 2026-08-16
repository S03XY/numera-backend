import { Module } from '@nestjs/common';
import { PricesController } from './prices.controller';
import { SparklinesController } from './sparklines.controller';
import { PricesService } from './prices.service';

@Module({
  controllers: [PricesController, SparklinesController],
  providers: [PricesService],
  exports: [PricesService],
})
export class PricesModule {}
