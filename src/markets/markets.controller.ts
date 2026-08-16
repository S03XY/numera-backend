import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { ListMarketsDto } from './dto/list-markets.dto';
import { MarketsService } from './markets.service';

@ApiTags('markets')
@Controller()
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  @Public()
  @Get('markets')
  @ApiOperation({ summary: 'List markets with filtering, sorting, and pagination.' })
  list(@Query() dto: ListMarketsDto) {
    return this.markets.list(dto);
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'List enabled market categories.' })
  categories() {
    return this.markets.listCategories();
  }

  @Public()
  @Get('markets/:id')
  @ApiOperation({ summary: 'Get a market (with outcomes and live prices) by id.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.markets.getById(id);
  }

  /**
   * Deliberately its own request rather than a field on the market.
   *
   * Every figure here is read live from the resolver, because every one of them moves: the bond is
   * a share of the market's pot and the reward a share of the fees it has earned. Folding them into
   * the cached market detail would either serve stale numbers — quoting a bond the chain will not
   * accept — or put an RPC round trip on the path of every market page load. Only a trader looking
   * at a closed market needs them, so only that view asks.
   */
  @Public()
  @Get('markets/:id/resolution/terms')
  @ApiOperation({
    summary: 'Live cost of proposing or disputing this market, and what being right pays.',
  })
  terms(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.markets.resolutionTerms(id);
  }
}
