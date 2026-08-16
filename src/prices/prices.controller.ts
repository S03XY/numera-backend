import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CandlesQueryDto } from './dto/candles.dto';
import { PricesService } from './prices.service';

@ApiTags('prices')
@Controller('markets/:id/prices')
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  @Public()
  @Get('candles')
  @ApiOperation({ summary: 'OHLC price candles for an outcome over a time range.' })
  candles(@Param('id', new ParseUUIDPipe()) id: string, @Query() dto: CandlesQueryDto) {
    return this.prices.candles(id, dto);
  }

  @Public()
  @Get('latest')
  @ApiOperation({ summary: 'Latest price per outcome for the market.' })
  latest(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.prices.latest(id);
  }
}
