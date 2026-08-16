import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { SparklinesQueryDto } from './dto/sparklines.dto';
import { PricesService } from './prices.service';

/**
 * Board-level price history.
 *
 * Its own controller because it is not scoped to one market — `markets/:id/prices` cannot express
 * a request that spans a page of them, and nesting a batch route under a single id would be a lie
 * about what it reads.
 */
@ApiTags('prices')
@Controller('prices')
export class SparklinesController {
  constructor(private readonly prices: PricesService) {}

  @Public()
  @Get('sparklines')
  @ApiOperation({ summary: 'Recent price shape for many markets in one query.' })
  sparklines(@Query() dto: SparklinesQueryDto) {
    return this.prices.sparklines(dto);
  }
}
