import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';
import { IsEthAddress } from '../../common/decorators/is-eth-address.decorator';

/**
 * A portfolio is assembled from the execution accounts the CLIENT knows are its
 * own (it holds the Unlink spending key). The server never persists the link
 * between these accounts and a login identity — passing them here is ephemeral.
 */
export class PortfolioQueryDto {
  @ApiProperty({
    type: [String],
    description: 'Execution account addresses to aggregate positions for.',
    example: ['0x1111111111111111111111111111111111111111'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsEthAddress({ each: true })
  accounts!: string[];
}
