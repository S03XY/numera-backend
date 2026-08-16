import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { IsEthAddress } from '../../common/decorators/is-eth-address.decorator';

export class ListTradesByAccountDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Execution account address to filter by.' })
  @IsOptional()
  @IsEthAddress()
  account?: string;
}
