import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { ListTradesByAccountDto } from './dto/list-trades.dto';
import { TradesService } from './trades.service';

@ApiTags('trades')
@Controller()
export class TradesController {
  constructor(private readonly trades: TradesService) {}

  @Public()
  @Get('markets/:id/trades')
  @ApiOperation({ summary: 'Recent trades for a market (newest first).' })
  byMarket(@Param('id', new ParseUUIDPipe()) id: string, @Query() dto: PaginationDto) {
    return this.trades.listByMarket(id, dto);
  }

  @Public()
  @Get('trades')
  @ApiOperation({
    summary: 'Global trade tape, or trades for a specific execution account via ?account=.',
  })
  list(@Query() dto: ListTradesByAccountDto) {
    if (dto.account) return this.trades.listByAccount(dto.account, dto);
    return this.trades.recent(dto);
  }
}
