import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { isValidAddress } from '../common/utils/address';
import { PortfolioQueryDto } from './dto/portfolio.dto';
import { PositionsService } from './positions.service';

@ApiTags('positions')
@Controller()
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @Public()
  @Post('positions/query')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Portfolio: aggregate positions for a client-supplied set of execution accounts.',
  })
  portfolio(@Body() dto: PortfolioQueryDto) {
    return this.positions.forAccounts(dto.accounts);
  }

  @Public()
  @Get('markets/:id/positions')
  @ApiOperation({ summary: 'Positions of one execution account within a market (?account=).' })
  byMarketAccount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('account') account: string,
  ) {
    if (!account || !isValidAddress(account)) {
      throw new BadRequestException('valid ?account= address is required');
    }
    return this.positions.forMarketAccount(id, account);
  }
}
